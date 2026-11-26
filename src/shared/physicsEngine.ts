import RAPIER from '@dimforge/rapier3d-compat';
import { ARENA_BOUNDS, BOOST_PADS, CAR_MAP, FFA_ARENA_BOUNDS, FFA_BOOST_PADS } from './constants.ts';
import type {
  ArenaId,
  BoostPadState,
  BotDifficulty,
  CarCustomization,
  CarStateSnapshot,
  MatchEvent,
  MatchPhase,
  MatchStateSnapshot,
  PartyGameMode,
  PlayerInput,
  Quat,
  Team,
  Vec3,
} from './types.ts';

let rapierReadyPromise: Promise<void> | null = null;

export function ensureRapierReady(): Promise<void> {
  if (!rapierReadyPromise) {
    rapierReadyPromise = RAPIER.init();
  }
  return rapierReadyPromise;
}

export interface CarActorConfig {
  id: string;
  name: string;
  team: Team;
  isBot: boolean;
  botDifficulty?: BotDifficulty;
  customization: CarCustomization;
  connected?: boolean;
}

interface InternalCar {
  config: CarActorConfig;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  boost: number;
  isBoosting: boolean;
  isGrounded: boolean;
  isSupersonic: boolean;
  steerAngle: number;
  wheelSpin: number;
  throttle: number;
  lastJumpPressed: boolean;
  doubleJumpWindow: number;
  hasDoubleJump: boolean;
  flipTimer: number;
  goals: number;
  shots: number;
  saves: number;
  ackSeq: number;
  input: PlayerInput;
  spawnPos: Vec3;
  spawnYaw: number;
}

function yawToQuat(yaw: number): Quat {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function rotateVecByQuat(v: Vec3, q: Quat): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export class PhysicsSimulation {
  world: RAPIER.World;
  ballBody: RAPIER.RigidBody;
  ballCollider: RAPIER.Collider;
  cars: Map<string, InternalCar> = new Map();
  boostPads: BoostPadState[] = [];

  arenaId: ArenaId;
  gameMode: PartyGameMode;
  matchDuration: number;
  isPractice: boolean;

  phase: MatchPhase = 'countdown';
  countdownTimer = 3.0;
  lastCountdownInt = 4;
  timeRemaining: number;
  isOvertime = false;
  goalCelebrationTimer = 0;

  blueScore = 0;
  orangeScore = 0;
  emeraldScore = 0;
  lastGoalTeam: Team | null = null;
  lastGoalScorer: string | null = null;
  lastGoalSpeedKmh = 0;

  lastTouchPlayerId: string | null = null;
  lastTouchTeam: Team | null = null;
  lastTouchTime = 0;
  shotCreditCooldown = 0;
  ballImpactCooldown = 0;

  tick = 0;
  events: MatchEvent[] = [];

  constructor(options: {
    arenaId: ArenaId;
    matchDuration: number;
    isPractice?: boolean;
    gameMode?: PartyGameMode;
  }) {
    this.arenaId = options.arenaId;
    this.gameMode = options.gameMode ?? 'team_2v1';
    this.matchDuration = options.matchDuration;
    this.isPractice = Boolean(options.isPractice);
    this.timeRemaining = options.matchDuration;

    this.world = new RAPIER.World({ x: 0, y: -19.6, z: 0 });
    this.world.timestep = 1 / 60;

    if (this.gameMode === 'ffa') {
      this.buildFfaArenaColliders();
    } else {
      this.buildArenaColliders();
    }

    // Create Ball
    const ballDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, ARENA_BOUNDS.BALL_RADIUS + 0.05, 0)
      .setLinearDamping(0.05)
      .setAngularDamping(0.16)
      .setGravityScale(0.68)
      .setCcdEnabled(true);
    this.ballBody = this.world.createRigidBody(ballDesc);

    const ballColDesc = RAPIER.ColliderDesc.ball(ARENA_BOUNDS.BALL_RADIUS)
      .setDensity(0.85)
      .setRestitution(0.79)
      .setFriction(0.45);
    this.ballCollider = this.world.createCollider(ballColDesc, this.ballBody);

    const padList = this.gameMode === 'ffa' ? FFA_BOOST_PADS : BOOST_PADS;
    this.boostPads = padList.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      isLarge: p.isLarge,
      active: true,
      cooldown: 0,
    }));

    if (this.isPractice) {
      this.phase = 'playing';
      this.countdownTimer = 0;
    }
  }

  private createStaticBox(
    hx: number,
    hy: number,
    hz: number,
    tx: number,
    ty: number,
    tz: number,
    rotEuler?: { x: number; y: number; z: number },
    restitution = 0.65,
    friction = 0.4
  ) {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(tx, ty, tz)
      .setRestitution(restitution)
      .setFriction(friction);

    if (rotEuler) {
      const cx = Math.cos(rotEuler.x * 0.5);
      const sx = Math.sin(rotEuler.x * 0.5);
      const cy = Math.cos(rotEuler.y * 0.5);
      const sy = Math.sin(rotEuler.y * 0.5);
      const cz = Math.cos(rotEuler.z * 0.5);
      const sz = Math.sin(rotEuler.z * 0.5);
      desc.setRotation({
        w: cx * cy * cz + sx * sy * sz,
        x: sx * cy * cz - cx * sy * sz,
        y: cx * sy * cz + sx * cy * sz,
        z: cx * cy * sz - sx * sy * cz,
      });
    }

    this.world.createCollider(desc);
  }

  private buildArenaColliders() {
    const hw = ARENA_BOUNDS.HALF_WIDTH;
    const hl = ARENA_BOUNDS.HALF_LENGTH;
    const h = ARENA_BOUNDS.HEIGHT;
    const gw = ARENA_BOUNDS.GOAL_HALF_WIDTH;
    const gh = ARENA_BOUNDS.GOAL_HEIGHT;
    const gd = ARENA_BOUNDS.GOAL_DEPTH;

    // Main floor (covers goals too)
    this.createStaticBox(hw + 4, 1.0, hl + gd + 4, 0, -1.0, 0, undefined, 0.55, 0.5);

    // Ceiling
    this.createStaticBox(hw + 4, 1.0, hl + gd + 4, 0, h + 1.0, 0, undefined, 0.6, 0.2);

    // Left & Right side walls
    this.createStaticBox(1.0, h * 0.5 + 2, hl + 2, -hw - 1.0, h * 0.5, 0, undefined, 0.72, 0.2);
    this.createStaticBox(1.0, h * 0.5 + 2, hl + 2, hw + 1.0, h * 0.5, 0, undefined, 0.72, 0.2);

    // End walls with goal cutout (Blue goal at +Z, Orange goal at -Z)
    const sideSegmentHalfW = (hw - gw) * 0.5;
    const sideSegmentCenterX = gw + sideSegmentHalfW;
    const upperWallHalfH = (h - gh) * 0.5;
    const upperWallCenterY = gh + upperWallHalfH;

    for (const sign of [-1, 1]) {
      const zWall = sign * (hl + 1.0);
      // Left and right wall pillars flanking goal
      this.createStaticBox(sideSegmentHalfW, h * 0.5 + 1, 1.0, -sideSegmentCenterX, h * 0.5, zWall, undefined, 0.72, 0.2);
      this.createStaticBox(sideSegmentHalfW, h * 0.5 + 1, 1.0, sideSegmentCenterX, h * 0.5, zWall, undefined, 0.72, 0.2);
      // Upper crossbar wall above goal
      this.createStaticBox(gw + 0.5, upperWallHalfH + 1, 1.0, 0, upperWallCenterY, zWall, undefined, 0.72, 0.2);

      // Goal box interior (back, left, right, roof)
      const zBack = sign * (hl + gd + 1.0);
      const zMid = sign * (hl + gd * 0.5);
      this.createStaticBox(gw + 1.0, gh * 0.5 + 1, 1.0, 0, gh * 0.5, zBack, undefined, 0.35, 0.6);
      this.createStaticBox(0.8, gh * 0.5 + 1, gd * 0.5 + 0.5, -gw - 0.8, gh * 0.5, zMid, undefined, 0.4, 0.5);
      this.createStaticBox(0.8, gh * 0.5 + 1, gd * 0.5 + 0.5, gw + 0.8, gh * 0.5, zMid, undefined, 0.4, 0.5);
      this.createStaticBox(gw + 1.0, 0.8, gd * 0.5 + 0.5, 0, gh + 0.8, zMid, undefined, 0.4, 0.5);
    }

    // 45-degree corner chamfer walls so the ball curves naturally around corners
    const corner = ARENA_BOUNDS.CORNER_SIZE;
    const cornerHyp = Math.sqrt(corner * corner * 2) * 0.5 + 1.2;
    const corners = [
      { x: -hw + corner * 0.5, z: -hl + corner * 0.5, ry: Math.PI * 0.25 },
      { x: hw - corner * 0.5, z: -hl + corner * 0.5, ry: -Math.PI * 0.25 },
      { x: -hw + corner * 0.5, z: hl - corner * 0.5, ry: -Math.PI * 0.25 },
      { x: hw - corner * 0.5, z: hl - corner * 0.5, ry: Math.PI * 0.25 },
    ];
    for (const c of corners) {
      this.createStaticBox(cornerHyp, h * 0.5, 1.0, c.x, h * 0.5, c.z, { x: 0, y: c.ry, z: 0 }, 0.74, 0.2);
    }

    // Gentle curved-feel lower side ramps (30-degree wedge along bottom of side walls)
    this.createStaticBox(1.8, 0.4, hl - corner, -hw + 0.6, 0.45, 0, { x: 0, y: 0, z: -0.52 }, 0.6, 0.45);
    this.createStaticBox(1.8, 0.4, hl - corner, hw - 0.6, 0.45, 0, { x: 0, y: 0, z: 0.52 }, 0.6, 0.45);
  }

  private buildFfaArenaColliders() {
    const A = FFA_ARENA_BOUNDS.APOTHEM;
    const h = FFA_ARENA_BOUNDS.HEIGHT;
    const gw = FFA_ARENA_BOUNDS.GOAL_HALF_WIDTH;
    const gh = FFA_ARENA_BOUNDS.GOAL_HEIGHT;
    const gd = FFA_ARENA_BOUNDS.GOAL_DEPTH;
    const sideHalfLen = A / Math.sqrt(3);

    // Wide circular/octagonal floor & ceiling
    this.createStaticBox(A + gd + 14, 1.0, A + gd + 14, 0, -1.0, 0, undefined, 0.55, 0.5);
    this.createStaticBox(A + gd + 14, 1.0, A + gd + 14, 0, h + 1.0, 0, undefined, 0.6, 0.2);

    const placeRotatedBox = (
      theta: number,
      hx: number,
      hy: number,
      hz: number,
      lx: number,
      ly: number,
      lz: number,
      restitution = 0.72,
      friction = 0.2
    ) => {
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const wx = lx * cosT + lz * sinT;
      const wz = -lx * sinT + lz * cosT;
      this.createStaticBox(hx, hy, hz, wx, ly, wz, { x: 0, y: theta, z: 0 }, restitution, friction);
    };

    const goalAngles = [
      FFA_ARENA_BOUNDS.GOAL_ANGLES.blue,
      FFA_ARENA_BOUNDS.GOAL_ANGLES.orange,
      FFA_ARENA_BOUNDS.GOAL_ANGLES.emerald,
    ];

    for (let i = 0; i < 6; i++) {
      const theta = (i * Math.PI) / 3;
      const isGoalSide = goalAngles.some((ga) => Math.abs(ga - theta) < 0.05);

      if (!isGoalSide) {
        placeRotatedBox(theta, sideHalfLen + 1.5, h * 0.5 + 1, 1.0, 0, h * 0.5, A + 1.0);
      } else {
        const segHalf = (sideHalfLen - gw) * 0.5;
        const segCenterX = gw + segHalf;
        const upperHalfH = (h - gh) * 0.5;
        const upperCenterY = gh + upperHalfH;

        placeRotatedBox(theta, segHalf + 0.8, h * 0.5 + 1, 1.0, -segCenterX, h * 0.5, A + 1.0);
        placeRotatedBox(theta, segHalf + 0.8, h * 0.5 + 1, 1.0, segCenterX, h * 0.5, A + 1.0);
        placeRotatedBox(theta, gw + 0.6, upperHalfH + 1, 1.0, 0, upperCenterY, A + 1.0);

        // Goal box interior
        const zBack = A + gd + 1.0;
        const zMid = A + gd * 0.5;
        placeRotatedBox(theta, gw + 1.0, gh * 0.5 + 1, 1.0, 0, gh * 0.5, zBack, 0.35, 0.6);
        placeRotatedBox(theta, 0.8, gh * 0.5 + 1, gd * 0.5 + 0.5, -gw - 0.8, gh * 0.5, zMid, 0.4, 0.5);
        placeRotatedBox(theta, 0.8, gh * 0.5 + 1, gd * 0.5 + 0.5, gw + 0.8, gh * 0.5, zMid, 0.4, 0.5);
        placeRotatedBox(theta, gw + 1.0, 0.8, gd * 0.5 + 0.5, 0, gh + 0.8, zMid, 0.4, 0.5);
      }
    }
  }

  public addCar(config: CarActorConfig, slotIndex: number, totalOnTeam: number): void {
    const carDef = CAR_MAP[config.customization.carId] ?? CAR_MAP.striker;
    const spawn = this.computeSpawn(config.team, slotIndex, totalOnTeam);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.pos.x, spawn.pos.y, spawn.pos.z)
      .setRotation(yawToQuat(spawn.yaw))
      .setLinearDamping(0.08)
      .setAngularDamping(2.6)
      .setCcdEnabled(true);

    const body = this.world.createRigidBody(bodyDesc);

    const hx = carDef.dimensions.width * 0.48;
    const hy = carDef.dimensions.height * 0.44;
    const hz = carDef.dimensions.length * 0.48;

    const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setDensity(14.5)
      .setRestitution(0.28)
      .setFriction(0.18);

    const collider = this.world.createCollider(colliderDesc, body);

    this.cars.set(config.id, {
      config: { ...config, connected: config.connected ?? true },
      body,
      collider,
      boost: this.isPractice ? 100 : 33,
      isBoosting: false,
      isGrounded: true,
      isSupersonic: false,
      steerAngle: 0,
      wheelSpin: 0,
      throttle: 0,
      lastJumpPressed: false,
      doubleJumpWindow: 0,
      hasDoubleJump: false,
      flipTimer: 0,
      goals: 0,
      shots: 0,
      saves: 0,
      ackSeq: 0,
      input: { seq: 0, throttle: 0, steer: 0, jump: false, boost: false, powerslide: false },
      spawnPos: spawn.pos,
      spawnYaw: spawn.yaw,
    });
  }

  public removeCar(id: string): void {
    const car = this.cars.get(id);
    if (!car) return;
    this.world.removeRigidBody(car.body);
    this.cars.delete(id);
  }

  public updateCarCustomization(id: string, customization: CarCustomization): void {
    const car = this.cars.get(id);
    if (car) {
      car.config.customization = customization;
    }
  }

  public setCarConnected(id: string, connected: boolean): void {
    const car = this.cars.get(id);
    if (car) {
      car.config.connected = connected;
    }
  }

  private computeSpawn(team: Team, slotIndex: number, totalOnTeam: number): { pos: Vec3; yaw: number } {
    if (this.gameMode === 'ffa') {
      const angle =
        team === 'blue'
          ? FFA_ARENA_BOUNDS.GOAL_ANGLES.blue
          : team === 'orange'
            ? FFA_ARENA_BOUNDS.GOAL_ANGLES.orange
            : FFA_ARENA_BOUNDS.GOAL_ANGLES.emerald;
      const dist = 28;
      const px = Math.sin(angle) * dist;
      const pz = Math.cos(angle) * dist;
      return {
        pos: { x: px, y: 0.72, z: pz },
        yaw: Math.atan2(px, pz),
      };
    }

    const dir = team === 'blue' ? 1 : -1;
    const presets =
      totalOnTeam <= 1
        ? [{ x: 0, z: 28 }]
        : totalOnTeam === 2
          ? [
              { x: -13, z: 24 },
              { x: 13, z: 24 },
            ]
          : [
              { x: -13, z: 22 },
              { x: 13, z: 22 },
              { x: 0, z: 34 },
              { x: -18, z: 28 },
              { x: 18, z: 28 },
            ];
    const p = presets[slotIndex % presets.length];
    const px = p.x * (team === 'blue' ? 1 : -1);
    const pz = p.z * dir;
    const yaw = Math.atan2(px, pz);
    return {
      pos: { x: px, y: 0.72, z: pz },
      yaw,
    };
  }

  public setInput(id: string, input: PlayerInput): void {
    const car = this.cars.get(id);
    if (!car) return;
    car.input = input;
    if (typeof input.seq === 'number' && input.seq > car.ackSeq) {
      car.ackSeq = input.seq;
    }
    if (input.reset) {
      if (this.isPractice) {
        this.resetKickoff(true);
      } else {
        this.resetSingleCar(car);
      }
      car.input.reset = false;
    }
  }

  private resetSingleCar(car: InternalCar): void {
    const t = car.body.translation();
    car.body.setTranslation({ x: t.x, y: Math.max(t.y, 1.0), z: t.z }, true);
    car.body.setRotation(yawToQuat(car.spawnYaw), true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  public resetKickoff(keepScore = true): void {
    if (!keepScore) {
      this.blueScore = 0;
      this.orangeScore = 0;
      this.emeraldScore = 0;
      this.timeRemaining = this.matchDuration;
      this.isOvertime = false;
      this.lastGoalTeam = null;
      this.lastGoalScorer = null;
      for (const car of this.cars.values()) {
        car.goals = 0;
        car.shots = 0;
        car.saves = 0;
      }
    }

    // Reset ball
    this.ballBody.setTranslation({ x: 0, y: ARENA_BOUNDS.BALL_RADIUS + 0.08, z: 0 }, true);
    this.ballBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.lastTouchPlayerId = null;
    this.lastTouchTeam = null;

    // Reset boost pads
    for (const pad of this.boostPads) {
      pad.active = true;
      pad.cooldown = 0;
    }

    // Reset cars by team
    const teams: Team[] = ['blue', 'orange', 'emerald'];
    for (const t of teams) {
      const teamCars = Array.from(this.cars.values()).filter((c) => c.config.team === t);
      teamCars.forEach((c, idx) => {
        const s = this.computeSpawn(t, idx, teamCars.length);
        c.spawnPos = s.pos;
        c.spawnYaw = s.yaw;
        c.body.setTranslation(s.pos, true);
        c.body.setRotation(yawToQuat(s.yaw), true);
        c.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        c.boost = this.isPractice ? 100 : 33;
        c.isBoosting = false;
        c.doubleJumpWindow = 0;
        c.hasDoubleJump = false;
      });
    }

    if (this.isPractice) {
      this.phase = 'playing';
      this.countdownTimer = 0;
    } else {
      this.phase = 'countdown';
      this.countdownTimer = 3.0;
      this.lastCountdownInt = 4;
    }
  }

  public step(dt = 1 / 60): MatchEvent[] {
    this.events = [];
    this.tick++;

    if (this.shotCreditCooldown > 0) this.shotCreditCooldown -= dt;
    if (this.ballImpactCooldown > 0) this.ballImpactCooldown -= dt;

    // Phase management
    if (this.phase === 'finished') {
      return this.events;
    }

    if (this.phase === 'countdown') {
      this.countdownTimer -= dt;
      const ceilVal = Math.max(0, Math.ceil(this.countdownTimer));
      if (ceilVal < this.lastCountdownInt && ceilVal >= 1) {
        this.lastCountdownInt = ceilVal;
        this.events.push({ type: 'countdown', countdown: ceilVal });
      }
      if (this.countdownTimer <= 0) {
        this.phase = 'playing';
        this.countdownTimer = 0;
        this.events.push({ type: 'kickoff' });
      }
      // During countdown, allow slight wheel spin / boost pad idle, freeze car positions
      this.world.step();
      return this.events;
    }

    if (this.phase === 'goal_scored') {
      this.goalCelebrationTimer -= dt;
      // Keep physics rolling in slow-mo celebration!
      this.stepVehicles(dt, false);
      this.world.step();
      if (this.goalCelebrationTimer <= 0) {
        if (this.isOvertime) {
          this.phase = 'finished';
          this.events.push({ type: 'match_end' });
        } else {
          this.resetKickoff(true);
        }
      }
      return this.events;
    }

    // Playing phase
    if (!this.isPractice) {
      if (!this.isOvertime) {
        this.timeRemaining = Math.max(0, this.timeRemaining - dt);
        if (this.timeRemaining <= 0) {
          const ballVel = this.ballBody.linvel();
          const ballPos = this.ballBody.translation();
          // Match ends if ball touches ground or settles
          if (ballPos.y <= ARENA_BOUNDS.BALL_RADIUS + 0.45 || Math.abs(ballVel.y) < 1.2) {
            const isTie =
              this.gameMode === 'ffa'
                ? (() => {
                    const scores = [this.blueScore, this.orangeScore, this.emeraldScore];
                    const maxS = Math.max(...scores);
                    return scores.filter((s) => s === maxS).length > 1;
                  })()
                : this.blueScore === this.orangeScore;
            if (isTie) {
              this.isOvertime = true;
              this.resetKickoff(true);
            } else {
              this.phase = 'finished';
              this.events.push({ type: 'match_end' });
              return this.events;
            }
          }
        }
      }
    }

    // Update boost pad cooldowns
    for (const pad of this.boostPads) {
      if (!pad.active) {
        pad.cooldown -= dt;
        if (pad.cooldown <= 0) {
          pad.active = true;
          pad.cooldown = 0;
        }
      }
    }

    this.stepVehicles(dt, true);
    this.world.step();
    this.handleBallCarInteractions(dt);
    this.checkGoalDetection();

    return this.events;
  }

  private stepVehicles(dt: number, allowControl: boolean): void {
    const ballPos = this.ballBody.translation();

    for (const car of this.cars.values()) {
      const body = car.body;
      const pos = body.translation();
      const quat = body.rotation();
      const vel = body.linvel();
      const carDef = CAR_MAP[car.config.customization.carId] ?? CAR_MAP.striker;

      // Local basis vectors (Forward = -Z in Three.js/standard vehicle coordinates)
      const forward = rotateVecByQuat({ x: 0, y: 0, z: -1 }, quat);
      const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, quat);
      const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, quat);

      // 4-Corner Raycast Suspension
      const hx = carDef.dimensions.width * 0.42;
      const hz = carDef.dimensions.length * 0.36;
      const rayOriginOffsets: Vec3[] = [
        { x: -hx, y: -0.1, z: -hz },
        { x: hx, y: -0.1, z: -hz },
        { x: -hx, y: -0.1, z: hz },
        { x: hx, y: -0.1, z: hz },
      ];

      const restLen = 0.64;
      const rayDir = { x: -up.x, y: -up.y, z: -up.z };
      let wheelsOnGround = 0;
      const springK = 3600;
      const damperC = 320;

      for (const localOff of rayOriginOffsets) {
        const worldOff = rotateVecByQuat(localOff, quat);
        const origin = {
          x: pos.x + worldOff.x,
          y: pos.y + worldOff.y,
          z: pos.z + worldOff.z,
        };
        const ray = new RAPIER.Ray(origin, rayDir);
        const hit = this.world.castRay(ray, restLen, true, undefined, undefined, car.collider, body);
        if (hit && hit.timeOfImpact <= restLen) {
          wheelsOnGround++;
          const compression = restLen - hit.timeOfImpact;
          // Velocity at wheel contact
          const angVel = body.angvel();
          const pointVel = {
            x: vel.x + (angVel.y * worldOff.z - angVel.z * worldOff.y),
            y: vel.y + (angVel.z * worldOff.x - angVel.x * worldOff.z),
            z: vel.z + (angVel.x * worldOff.y - angVel.y * worldOff.x),
          };
          const normalVel = dot(pointVel, up);
          const forceMag = Math.max(0, compression * springK - normalVel * damperC);
          body.applyImpulseAtPoint(
            { x: up.x * forceMag * dt, y: up.y * forceMag * dt, z: up.z * forceMag * dt },
            origin,
            true
          );
        }
      }

      car.isGrounded = wheelsOnGround >= 2;

      if (car.isGrounded) {
        car.hasDoubleJump = true;
        car.doubleJumpWindow = 0;
        body.setAngularDamping(3.4);
      } else {
        body.setAngularDamping(1.3);
        if (car.doubleJumpWindow > 0) {
          car.doubleJumpWindow -= dt;
        }
      }

      if (car.flipTimer > 0) {
        car.flipTimer -= dt;
      }

      const input = allowControl
        ? car.input
        : { seq: 0, throttle: 0, steer: 0, jump: false, boost: false, powerslide: false };

      car.throttle = input.throttle;

      // Speed decomposition
      const forwardSpeed = dot(vel, forward);
      const rightSpeed = dot(vel, right);
      const totalSpeed = len(vel);
      car.isSupersonic = totalSpeed > 33;
      car.wheelSpin += forwardSpeed * dt * 2.2;

      // Smooth visual steering angle
      const targetSteer = -input.steer * 0.42;
      car.steerAngle += (targetSteer - car.steerAngle) * Math.min(1, dt * 14);

      // Boost logic
      const wantsBoost = input.boost && car.boost > 0.5;
      car.isBoosting = wantsBoost;
      if (wantsBoost) {
        const boostRate = this.isPractice ? 18 : 32;
        car.boost = Math.max(0, car.boost - boostRate * dt);
        const boostForce = 4400;
        body.applyImpulse(
          {
            x: forward.x * boostForce * dt,
            y: forward.y * boostForce * dt,
            z: forward.z * boostForce * dt,
          },
          true
        );
      } else {
        // Gentle passive regeneration so players never get permanently stuck
        const regenRate = this.isPractice ? 22 : 4.5;
        car.boost = Math.min(100, car.boost + regenRate * dt);
      }

      // Ground driving physics
      if (car.isGrounded) {
        // Forward acceleration / reverse / braking
        const maxSpeed = car.isBoosting ? 46 : 31;
        const maxRevSpeed = 19;
        let driveAccel = 0;

        if (input.throttle > 0.05) {
          if (forwardSpeed < maxSpeed) {
            const falloff = Math.max(0.25, 1 - Math.max(0, forwardSpeed) / (maxSpeed * 1.15));
            driveAccel = input.throttle * 3400 * falloff;
          }
        } else if (input.throttle < -0.05) {
          if (forwardSpeed > 2.0) {
            // Braking
            driveAccel = input.throttle * 4600;
          } else if (forwardSpeed > -maxRevSpeed) {
            // Reversing
            driveAccel = input.throttle * 2500;
          }
        } else {
          // Rolling drag
          driveAccel = -forwardSpeed * 110;
        }

        body.applyImpulse(
          {
            x: forward.x * driveAccel * dt,
            y: forward.y * driveAccel * dt,
            z: forward.z * driveAccel * dt,
          },
          true
        );

        // Lateral tire grip (powerslide reduces lateral grip for crisp drifts!)
        const lateralGrip = input.powerslide ? 220 : 1450;
        const lateralImpulse = -rightSpeed * lateralGrip;
        body.applyImpulse(
          {
            x: right.x * lateralImpulse * dt,
            y: right.y * lateralImpulse * dt,
            z: right.z * lateralImpulse * dt,
          },
          true
        );

        // Steering yaw torque
        const speedFactor = Math.min(1, Math.abs(forwardSpeed) / 7.5);
        const revSign = forwardSpeed >= -0.8 ? 1 : -1;
        const driftMult = input.powerslide ? 1.48 : 1.0;
        const turnTorque = -input.steer * speedFactor * revSign * driftMult * 1550;
        body.applyTorqueImpulse(
          {
            x: up.x * turnTorque * dt,
            y: up.y * turnTorque * dt,
            z: up.z * turnTorque * dt,
          },
          true
        );

        // Keep upright when grounded on flat floor
        if (up.y > 0.4) {
          const stabilizeX = (0 - up.z) * 0; // gentle roll/pitch damping via upright alignment
          void stabilizeX;
          const uprightTorque = {
            x: -right.y * 420 * dt,
            y: 0,
            z: forward.y * 420 * dt,
          };
          // Cross product (up x worldUp)
          const cx = up.y * 0 - up.z * 1;
          const cz = up.x * 1 - up.y * 0;
          body.applyTorqueImpulse({ x: cx * 380 * dt, y: uprightTorque.y, z: cz * 380 * dt }, true);
        }
      } else {
        // Air Control: pitch (W down / S up), yaw (A/D), or air roll (Powerslide + A/D)
        if (car.flipTimer <= 0) {
          const airPitch = -input.throttle * 420 * dt;
          if (input.powerslide) {
            const airRoll = -input.steer * 520 * dt;
            body.applyTorqueImpulse(
              {
                x: right.x * airPitch + forward.x * airRoll,
                y: right.y * airPitch + forward.y * airRoll,
                z: right.z * airPitch + forward.z * airRoll,
              },
              true
            );
          } else {
            const airYaw = -input.steer * 420 * dt;
            body.applyTorqueImpulse(
              {
                x: right.x * airPitch + up.x * airYaw,
                y: right.y * airPitch + up.y * airYaw,
                z: right.z * airPitch + up.z * airYaw,
              },
              true
            );
          }
        }

        // If upside-down on the floor (stuck on roof), gently self-right
        if (pos.y < 1.1 && up.y < 0.15 && Math.abs(vel.y) < 0.8) {
          const cx = -up.z;
          const cz = up.x;
          body.applyTorqueImpulse({ x: cx * 700 * dt, y: 0, z: cz * 700 * dt }, true);
        }
      }

      // Jump & Double Jump / Flip on rising edge of jump
      const jumpRisingEdge = input.jump && !car.lastJumpPressed;
      car.lastJumpPressed = input.jump;

      if (jumpRisingEdge) {
        if (car.isGrounded) {
          // Primary Jump
          body.applyImpulse({ x: up.x * 1450, y: up.y * 1450 + 350, z: up.z * 1450 }, true);
          car.doubleJumpWindow = 1.35;
          car.hasDoubleJump = true;
          car.isGrounded = false;
          this.events.push({ type: 'jump', pos: { x: pos.x, y: pos.y, z: pos.z } });
        } else if (car.hasDoubleJump && car.doubleJumpWindow > 0) {
          car.hasDoubleJump = false;
          car.doubleJumpWindow = 0;

          const hasDir = Math.abs(input.throttle) > 0.25 || Math.abs(input.steer) > 0.25;
          if (hasDir) {
            // Directional Dodge Flip!
            car.flipTimer = 0.42;
            const dodgeDir = {
              x: forward.x * input.throttle + right.x * input.steer,
              y: 0,
              z: forward.z * input.throttle + right.z * input.steer,
            };
            const dLen = Math.max(0.001, len(dodgeDir));
            dodgeDir.x /= dLen;
            dodgeDir.z /= dLen;

            // Cancel downward velocity slightly for crisp dodge
            const curV = body.linvel();
            body.setLinvel({ x: curV.x, y: Math.max(curV.y, 1.5), z: curV.z }, true);
            body.applyImpulse({ x: dodgeDir.x * 1850, y: 420, z: dodgeDir.z * 1850 }, true);

            // Spin torque for visual & physical flip
            const flipTorque = {
              x: (-right.x * input.throttle + forward.x * -input.steer) * 850,
              y: 0,
              z: (-right.z * input.throttle + forward.z * -input.steer) * 850,
            };
            body.applyTorqueImpulse(flipTorque, true);
          } else {
            // Neutral Double Jump
            body.applyImpulse({ x: 0, y: 1380, z: 0 }, true);
          }
          this.events.push({ type: 'jump', pos: { x: pos.x, y: pos.y, z: pos.z } });
        }
      }

      // Clamp maximum car speed
      const curV = body.linvel();
      const curSpd = len(curV);
      if (curSpd > 52) {
        const s = 52 / curSpd;
        body.setLinvel({ x: curV.x * s, y: curV.y * s, z: curV.z * s }, true);
      }

      // Boost pad collection
      for (const pad of this.boostPads) {
        if (!pad.active) continue;
        const dx = pos.x - pad.x;
        const dz = pos.z - pad.z;
        const radius = pad.isLarge ? 2.4 : 1.75;
        if (pos.y < 2.2 && dx * dx + dz * dz < radius * radius && car.boost < 99.5) {
          pad.active = false;
          pad.cooldown = pad.isLarge ? 10 : 4;
          car.boost = Math.min(100, car.boost + (pad.isLarge ? 100 : 18));
          this.events.push({ type: 'boost_pickup', pos: { x: pad.x, y: 0.5, z: pad.z } });
        }
      }

      // Track saves/shots proximity heuristic
      void ballPos;
    }
  }

  private handleBallCarInteractions(_dt: number): void {
    const ballPos = this.ballBody.translation();
    const ballVel = this.ballBody.linvel();

    // Clamp ball max speed
    const bSpeed = len(ballVel);
    if (bSpeed > 66) {
      const s = 66 / bSpeed;
      this.ballBody.setLinvel({ x: ballVel.x * s, y: ballVel.y * s, z: ballVel.z * s }, true);
    }

    for (const car of this.cars.values()) {
      const cPos = car.body.translation();
      const dx = ballPos.x - cPos.x;
      const dy = ballPos.y - cPos.y;
      const dz = ballPos.z - cPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < ARENA_BOUNDS.BALL_RADIUS + 2.35) {
        const cVel = car.body.linvel();
        const relSpeed = len({
          x: cVel.x - ballVel.x,
          y: cVel.y - ballVel.y,
          z: cVel.z - ballVel.z,
        });

        if (this.lastTouchPlayerId !== car.config.id || this.tick - this.lastTouchTime > 12) {
          this.lastTouchPlayerId = car.config.id;
          this.lastTouchTeam = car.config.team;
          this.lastTouchTime = this.tick;

          // Add extra power-hit pop when car strikes ball hard
          if (relSpeed > 6 && dist > 0.01) {
            const nx = dx / dist;
            const ny = Math.max(0.06, Math.min(0.42, (dy - 0.15) / dist));
            const nz = dz / dist;
            const pop = Math.min(480, relSpeed * 12);
            this.ballBody.applyImpulse({ x: nx * pop, y: ny * pop * 0.55, z: nz * pop }, true);

            // Shot / Save detection
            if (this.shotCreditCooldown <= 0) {
              const targetGoalZ = car.config.team === 'blue' ? -ARENA_BOUNDS.HALF_LENGTH : ARENA_BOUNDS.HALF_LENGTH;
              if (Math.sign(nz) === Math.sign(targetGoalZ) && Math.abs(ballPos.x) < 22) {
                car.shots++;
                this.shotCreditCooldown = 2.0;
              } else if (Math.abs(cPos.z) > ARENA_BOUNDS.HALF_LENGTH - 18 && Math.sign(cPos.z) === (car.config.team === 'blue' ? 1 : -1)) {
                car.saves++;
                this.shotCreditCooldown = 2.0;
              }
            }
          }

          if (this.ballImpactCooldown <= 0 && relSpeed > 4) {
            this.ballImpactCooldown = 0.12;
            this.events.push({
              type: 'impact',
              intensity: Math.min(1, relSpeed / 36),
              pos: { x: ballPos.x, y: ballPos.y, z: ballPos.z },
            });
          }
        }
      }
    }
  }

  private checkGoalDetection(): void {
    const ballPos = this.ballBody.translation();
    const ballVel = this.ballBody.linvel();

    if (this.gameMode === 'ffa') {
      const A = FFA_ARENA_BOUNDS.APOTHEM;
      const gw = FFA_ARENA_BOUNDS.GOAL_HALF_WIDTH;
      const gh = FFA_ARENA_BOUNDS.GOAL_HEIGHT;
      const r = FFA_ARENA_BOUNDS.BALL_RADIUS;
      if (ballPos.y >= gh) return;

      const goals: { team: Team; angle: number }[] = [
        { team: 'blue', angle: FFA_ARENA_BOUNDS.GOAL_ANGLES.blue },
        { team: 'orange', angle: FFA_ARENA_BOUNDS.GOAL_ANGLES.orange },
        { team: 'emerald', angle: FFA_ARENA_BOUNDS.GOAL_ANGLES.emerald },
      ];
      for (const g of goals) {
        const sinT = Math.sin(g.angle);
        const cosT = Math.cos(g.angle);
        const localZ = ballPos.x * sinT + ballPos.z * cosT;
        const localX = ballPos.x * cosT - ballPos.z * sinT;
        if (Math.abs(localX) < gw && localZ > A + r * 0.45) {
          this.triggerFfaGoal(g.team, ballVel);
          return;
        }
      }
      return;
    }

    const hl = ARENA_BOUNDS.HALF_LENGTH;
    const gw = ARENA_BOUNDS.GOAL_HALF_WIDTH;
    const r = ARENA_BOUNDS.BALL_RADIUS;

    if (Math.abs(ballPos.x) < gw && ballPos.y < ARENA_BOUNDS.GOAL_HEIGHT) {
      // Ball crossed into Orange goal (-Z) -> Blue scores!
      if (ballPos.z < -(hl + r * 0.45)) {
        this.triggerGoal('blue', ballVel);
      }
      // Ball crossed into Blue goal (+Z) -> Orange scores!
      else if (ballPos.z > hl + r * 0.45) {
        this.triggerGoal('orange', ballVel);
      }
    }
  }

  private triggerFfaGoal(defendingTeam: Team, ballVel: Vec3): void {
    if (this.phase !== 'playing') return;

    const allTeams: Team[] = ['blue', 'orange', 'emerald'];
    let scoringTeam: Team | null = null;
    let scorerName = 'Arena Rival';

    if (this.lastTouchTeam && this.lastTouchTeam !== defendingTeam) {
      scoringTeam = this.lastTouchTeam;
      if (scoringTeam === 'blue') this.blueScore++;
      else if (scoringTeam === 'orange') this.orangeScore++;
      else this.emeraldScore++;

      if (this.lastTouchPlayerId) {
        const scorer = this.cars.get(this.lastTouchPlayerId);
        if (scorer) {
          scorer.goals++;
          scorerName = scorer.config.name;
        }
      }
    } else {
      // Own goal or unassisted: award +1 to both opponents
      for (const t of allTeams) {
        if (t !== defendingTeam) {
          if (t === 'blue') this.blueScore++;
          else if (t === 'orange') this.orangeScore++;
          else this.emeraldScore++;
        }
      }
      const otherCars = Array.from(this.cars.values()).filter((c) => c.config.team !== defendingTeam);
      otherCars.forEach((c) => c.goals++);
      scoringTeam = allTeams.find((t) => t !== defendingTeam) ?? 'blue';
      scorerName = 'Own Goal (Rivals +1)';
    }

    const speedKmh = Math.round(len(ballVel) * 3.6);
    this.lastGoalTeam = scoringTeam;
    this.lastGoalScorer = scorerName;
    this.lastGoalSpeedKmh = speedKmh;
    this.phase = 'goal_scored';
    this.goalCelebrationTimer = 3.2;

    const ballPos = this.ballBody.translation();
    for (const car of this.cars.values()) {
      const cp = car.body.translation();
      const dx = cp.x - ballPos.x;
      const dy = cp.y - ballPos.y + 1.5;
      const dz = cp.z - ballPos.z;
      const d = Math.max(4, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const blast = Math.max(0, 1 - d / 55) * 4200;
      car.body.applyImpulse({ x: (dx / d) * blast, y: (dy / d) * blast * 0.65, z: (dz / d) * blast }, true);
    }

    this.events.push({
      type: 'goal',
      team: scoringTeam,
      scorer: scorerName,
      speedKmh,
      pos: { x: ballPos.x, y: ballPos.y, z: ballPos.z },
    });
  }

  private triggerGoal(scoringTeam: Team, ballVel: Vec3): void {
    if (this.phase !== 'playing') return;

    if (!this.isPractice) {
      if (scoringTeam === 'blue') this.blueScore++;
      else this.orangeScore++;
    }

    const speedKmh = Math.round(len(ballVel) * 3.6);
    let scorerName = scoringTeam === 'blue' ? 'Blue Team' : 'Orange Team';

    if (this.lastTouchPlayerId && this.lastTouchTeam === scoringTeam) {
      const scorer = this.cars.get(this.lastTouchPlayerId);
      if (scorer) {
        scorer.goals++;
        scorerName = scorer.config.name;
      }
    }

    this.lastGoalTeam = scoringTeam;
    this.lastGoalScorer = scorerName;
    this.lastGoalSpeedKmh = speedKmh;
    this.phase = 'goal_scored';
    this.goalCelebrationTimer = this.isPractice ? 2.0 : 3.2;

    const ballPos = this.ballBody.translation();
    for (const car of this.cars.values()) {
      const cp = car.body.translation();
      const dx = cp.x - ballPos.x;
      const dy = cp.y - ballPos.y + 1.5;
      const dz = cp.z - ballPos.z;
      const d = Math.max(4, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const blast = Math.max(0, 1 - d / 55) * 4200;
      car.body.applyImpulse({ x: (dx / d) * blast, y: (dy / d) * blast * 0.65, z: (dz / d) * blast }, true);
    }

    this.events.push({
      type: 'goal',
      team: scoringTeam,
      scorer: scorerName,
      speedKmh,
      pos: { x: ballPos.x, y: ballPos.y, z: ballPos.z },
    });
  }

  public getSnapshot(): MatchStateSnapshot {
    const cars: CarStateSnapshot[] = [];
    for (const car of this.cars.values()) {
      const p = car.body.translation();
      const q = car.body.rotation();
      const v = car.body.linvel();
      const av = car.body.angvel();
      cars.push({
        id: car.config.id,
        name: car.config.name,
        team: car.config.team,
        isBot: car.config.isBot,
        customization: car.config.customization,
        pos: { x: p.x, y: p.y, z: p.z },
        quat: { x: q.x, y: q.y, z: q.z, w: q.w },
        vel: { x: v.x, y: v.y, z: v.z },
        angVel: { x: av.x, y: av.y, z: av.z },
        boost: car.boost,
        isBoosting: car.isBoosting,
        isGrounded: car.isGrounded,
        isSupersonic: car.isSupersonic,
        steerAngle: car.steerAngle,
        wheelSpin: car.wheelSpin,
        throttle: car.throttle,
        goals: car.goals,
        shots: car.shots,
        saves: car.saves,
        connected: car.config.connected ?? true,
        ackSeq: car.ackSeq,
      });
    }

    const bp = this.ballBody.translation();
    const bq = this.ballBody.rotation();
    const bv = this.ballBody.linvel();
    const bav = this.ballBody.angvel();

    return {
      phase: this.phase,
      arenaId: this.arenaId,
      gameMode: this.gameMode,
      countdown: Math.max(0, Math.ceil(this.countdownTimer)),
      timeRemaining: Math.ceil(this.timeRemaining),
      isOvertime: this.isOvertime,
      blueScore: this.blueScore,
      orangeScore: this.orangeScore,
      emeraldScore: this.emeraldScore,
      lastGoalTeam: this.lastGoalTeam,
      lastGoalScorer: this.lastGoalScorer,
      lastGoalSpeedKmh: this.lastGoalSpeedKmh,
      cars,
      ball: {
        pos: { x: bp.x, y: bp.y, z: bp.z },
        quat: { x: bq.x, y: bq.y, z: bq.z, w: bq.w },
        vel: { x: bv.x, y: bv.y, z: bv.z },
        angVel: { x: bav.x, y: bav.y, z: bav.z },
        lastTouchPlayerId: this.lastTouchPlayerId,
        lastTouchTeam: this.lastTouchTeam,
      },
      boostPads: this.boostPads.map((p) => ({ ...p })),
      tick: this.tick,
      serverTime: Date.now(),
    };
  }

  public dispose(): void {
    this.world.free();
  }
}
