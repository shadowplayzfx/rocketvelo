import { ARENA_BOUNDS } from './constants.ts';
import type {
  BallStateSnapshot,
  BoostPadState,
  BotDifficulty,
  CarStateSnapshot,
  PlayerInput,
} from './types.ts';

function forwardFromQuat(q: { x: number; y: number; z: number; w: number }) {
  // Rotate (0, 0, -1) by q
  const ix = -q.y;
  const iy = q.x;
  const iz = -q.w;
  const iw = q.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export class BotAIController {
  private seqCounter = 0;

  public computeInput(
    bot: CarStateSnapshot,
    ball: BallStateSnapshot,
    boostPads: BoostPadState[],
    allCars: CarStateSnapshot[],
    difficulty: BotDifficulty,
    tick: number
  ): PlayerInput {
    this.seqCounter++;

    // Team attack direction: Blue attacks -Z goal, Orange attacks +Z goal
    const attackDirZ = bot.team === 'blue' ? -1 : 1;
    const ownGoalZ = bot.team === 'blue' ? ARENA_BOUNDS.HALF_LENGTH : -ARENA_BOUNDS.HALF_LENGTH;
    const enemyGoalZ = -ownGoalZ;

    // Difficulty parameters
    const params = {
      beginner: {
        lookAhead: 0.05,
        steerGain: 1.4,
        maxThrottle: 0.62,
        useBoost: false,
        useJump: false,
        useFlip: false,
        usePowerslide: false,
        offsetScale: 0.0,
        reactionJitter: 0.28,
      },
      easy: {
        lookAhead: 0.25,
        steerGain: 2.0,
        maxThrottle: 0.78,
        useBoost: true,
        useJump: false,
        useFlip: false,
        usePowerslide: false,
        offsetScale: 0.45,
        reactionJitter: 0.14,
      },
      medium: {
        lookAhead: 0.45,
        steerGain: 2.5,
        maxThrottle: 0.92,
        useBoost: true,
        useJump: true,
        useFlip: false,
        usePowerslide: true,
        offsetScale: 0.85,
        reactionJitter: 0.05,
      },
      hard: {
        lookAhead: 0.72,
        steerGain: 3.1,
        maxThrottle: 1.0,
        useBoost: true,
        useJump: true,
        useFlip: true,
        usePowerslide: true,
        offsetScale: 1.0,
        reactionJitter: 0.0,
      },
      professional: {
        lookAhead: 0.92,
        steerGain: 3.6,
        maxThrottle: 1.0,
        useBoost: true,
        useJump: true,
        useFlip: true,
        usePowerslide: true,
        offsetScale: 1.15,
        reactionJitter: 0.0,
      },
    }[difficulty];

    // Predict ball future position
    const predBallX = clamp(ball.pos.x + ball.vel.x * params.lookAhead, -ARENA_BOUNDS.HALF_WIDTH + 3, ARENA_BOUNDS.HALF_WIDTH - 3);
    const predBallZ = clamp(ball.pos.z + ball.vel.z * params.lookAhead, -ARENA_BOUNDS.HALF_LENGTH + 2, ARENA_BOUNDS.HALF_LENGTH - 2);
    const predBallY = Math.max(ARENA_BOUNDS.BALL_RADIUS, ball.pos.y + ball.vel.y * params.lookAhead - 6.5 * params.lookAhead * params.lookAhead);

    // Check if bot is on the wrong side of the ball (ball is closer to own goal than bot)
    const botDistToOwnGoal = Math.abs(bot.pos.z - ownGoalZ);
    const ballDistToOwnGoal = Math.abs(predBallZ - ownGoalZ);
    const wrongSide = botDistToOwnGoal > ballDistToOwnGoal + 3.0;

    let targetX = predBallX;
    let targetZ = predBallZ;

    // Check if another teammate is significantly closer to ball (rotation)
    const distBotBall = Math.hypot(predBallX - bot.pos.x, predBallZ - bot.pos.z);
    let teammateCloser = false;
    if (difficulty === 'hard' || difficulty === 'professional') {
      for (const other of allCars) {
        if (other.id !== bot.id && other.team === bot.team) {
          const dOther = Math.hypot(predBallX - other.pos.x, predBallZ - other.pos.z);
          if (dOther + 6 < distBotBall) {
            teammateCloser = true;
            break;
          }
        }
      }
    }

    if (teammateCloser && !wrongSide) {
      // Midfield support / shadow defense position
      targetX = predBallX * 0.4;
      targetZ = clamp(predBallZ - attackDirZ * 22, -ARENA_BOUNDS.HALF_LENGTH + 8, ARENA_BOUNDS.HALF_LENGTH - 8);
    } else if (wrongSide && params.offsetScale > 0.2) {
      // Rotate back toward own goal post away from ball line to clear cleanly
      const sideOffset = bot.pos.x > predBallX ? 9 : -9;
      targetX = clamp(predBallX + sideOffset, -ARENA_BOUNDS.HALF_WIDTH + 6, ARENA_BOUNDS.HALF_WIDTH - 6);
      targetZ = clamp(predBallZ - attackDirZ * 14, -ARENA_BOUNDS.HALF_LENGTH + 6, ARENA_BOUNDS.HALF_LENGTH - 6);
    } else {
      // Approach from behind the ball aligned with enemy goal!
      const toGoalX = 0 - predBallX;
      const toGoalZ = enemyGoalZ - predBallZ;
      const toGoalLen = Math.max(1, Math.hypot(toGoalX, toGoalZ));
      const dirX = toGoalX / toGoalLen;
      const dirZ = toGoalZ / toGoalLen;

      // Stand-off distance scales down as bot gets close to strike!
      const standOff = clamp(distBotBall * 0.35, 0, 5.2) * params.offsetScale;
      targetX = predBallX - dirX * standOff;
      targetZ = predBallZ - dirZ * standOff;
    }

    // Grab nearby boost pad if low on boost and not in immediate danger
    if (params.useBoost && bot.boost < 28 && distBotBall > 18 && !wrongSide) {
      let bestPad: BoostPadState | null = null;
      let bestScore = Infinity;
      for (const pad of boostPads) {
        if (!pad.active) continue;
        const d = Math.hypot(pad.x - bot.pos.x, pad.z - bot.pos.z);
        const score = d - (pad.isLarge ? 10 : 0);
        if (d < 22 && score < bestScore) {
          bestScore = score;
          bestPad = pad;
        }
      }
      if (bestPad) {
        targetX = bestPad.x;
        targetZ = bestPad.z;
      }
    }

    // Add slight jitter for lower difficulties
    if (params.reactionJitter > 0) {
      const wave = Math.sin(tick * 0.07 + bot.pos.x * 0.1) * params.reactionJitter * 12;
      targetX += wave;
    }

    // Compute steering angle relative to car's forward vector
    const fwd = forwardFromQuat(bot.quat);
    const toTargetX = targetX - bot.pos.x;
    const toTargetZ = targetZ - bot.pos.z;
    const distToTarget = Math.max(0.01, Math.hypot(toTargetX, toTargetZ));
    const desiredX = toTargetX / distToTarget;
    const desiredZ = toTargetZ / distToTarget;

    // 2D angle difference in XZ plane
    const fwdLen = Math.max(0.01, Math.hypot(fwd.x, fwd.z));
    const fx = fwd.x / fwdLen;
    const fz = fwd.z / fwdLen;

    const dotAngle = clamp(fx * desiredX + fz * desiredZ, -1, 1);
    // Cross product Y component (fx * desiredZ - fz * desiredX)
    // Remember: -Z is forward, +X is right. Left turn is steer = -1, Right turn is steer = +1.
    const crossY = fx * desiredZ - fz * desiredX;
    const angleDiff = Math.atan2(crossY, dotAngle);

    // If target is directly behind and very close, reverse slightly or powerslide hard
    let throttle = params.maxThrottle;
    let steer = clamp(angleDiff * params.steerGain, -1, 1);
    let powerslide = false;

    if (Math.abs(angleDiff) > 1.25) {
      if (params.usePowerslide && Math.hypot(bot.vel.x, bot.vel.z) > 10) {
        powerslide = true;
      } else if (distToTarget < 11 && Math.abs(angleDiff) > 2.1) {
        // Reverse out of awkward angle
        throttle = -0.8;
        steer = -steer;
      }
    }

    // Boost decision
    const aligned = Math.abs(angleDiff) < 0.34;
    let boost = false;
    if (params.useBoost && bot.boost > 8 && aligned && distToTarget > 9) {
      if (difficulty === 'professional' || difficulty === 'hard') {
        boost = true;
      } else if (difficulty === 'medium' && bot.boost > 20) {
        boost = true;
      } else if (difficulty === 'easy' && bot.boost > 45 && tick % 40 < 18) {
        boost = true;
      }
    }

    // Jump & aerial/flip decision
    let jump = false;
    const speed = Math.hypot(bot.vel.x, bot.vel.z);

    if (params.useJump && bot.isGrounded && aligned) {
      // Jump into elevated ball when close
      if (distBotBall < 9.5 && predBallY > 2.6 && predBallY < 8.5) {
        jump = true;
      }
      // Professional/Hard bots jump+boost for aerial hits!
      if (difficulty === 'professional' && distBotBall < 18 && predBallY > 4.5 && predBallY < 13 && bot.boost > 35) {
        jump = true;
        boost = true;
      }
    }

    // Flip shot / speed flip
    if (params.useFlip && !bot.isGrounded && bot.pos.y > 0.7 && bot.pos.y < 2.8) {
      if (distBotBall < 6.5 && aligned && tick % 3 === 0) {
        jump = true; // triggers dodge flip in physics engine
      } else if (distToTarget > 32 && speed > 18 && aligned && tick % 12 === 0 && bot.boost < 25) {
        jump = true;
      }
    }

    // Air control leveling when airborne
    if (!bot.isGrounded && distBotBall > 8) {
      throttle = 0; // avoid nosing into ground randomly
      if (difficulty === 'professional' && predBallY > 4 && distBotBall < 18 && aligned) {
        // Aim nose up slightly toward aerial ball
        throttle = -0.35;
        boost = bot.boost > 10;
      }
    }

    return {
      seq: this.seqCounter,
      throttle,
      steer,
      jump,
      boost,
      powerslide,
    };
  }
}
