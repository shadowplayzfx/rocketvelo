import * as THREE from 'three';
import { BOOST_TRAIL_CATALOG, CAR_MAP } from '../shared/constants.ts';
import type { BoostTrailId, CarCustomization, CarId } from '../shared/types.ts';
import { applyFresnelRimShader, createBoostFlameShaderMaterial } from './shaders.ts';
import {
  createBrushedMetalTexture,
  createCarFlakeNormalTexture,
  createCarLiveryTexture,
  createCarbonFiberTexture,
  createTireTreadNormalTexture,
} from './textures.ts';

export interface CarMeshHandle {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  wheelSteerPivots: THREE.Group[]; // [FL, FR]
  wheelSpinGroups: THREE.Group[]; // [FL, FR, RL, RR]
  flameMeshes: THREE.Mesh[];
  boostLight: THREE.PointLight | null;
  updateAppearance: (customization: CarCustomization, teamColorHex?: string) => void;
  updateDynamicState: (opts: {
    steerAngle: number;
    wheelSpin: number;
    isBoosting: boolean;
    throttle: number;
    time: number;
  }) => void;
  setFirstPersonMode: (enabled: boolean) => void;
  dispose: () => void;
}

// Shared immutable procedural texture cache to minimize GPU uploads across cars
let _sharedCarTextures: {
  flakeNormal: THREE.DataTexture;
  carbon: THREE.CanvasTexture;
  treadNormal: THREE.DataTexture;
  brushed: THREE.CanvasTexture;
} | null = null;

function getSharedCarTextures() {
  if (!_sharedCarTextures) {
    _sharedCarTextures = {
      flakeNormal: createCarFlakeNormalTexture(4),
      carbon: createCarbonFiberTexture(4),
      treadNormal: createTireTreadNormalTexture(4),
      brushed: createBrushedMetalTexture(4),
    };
  }
  return _sharedCarTextures;
}

function createSmoothProfileShape(points: [number, number][]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  const curvePts = points.slice(1).map(([x, y]) => new THREE.Vector2(x, y));
  shape.splineThru(curvePts);
  shape.lineTo(points[0][0], points[0][1]);
  return shape;
}

function getSculptedProfilePoints(carId: CarId, halfL: number, h: number): [number, number][] {
  // X goes from -halfL (rear, becomes +Z after rotY(PI/2)) to +halfL (front, becomes -Z)
  switch (carId) {
    case 'nomad': // Octane: aggressive hatchback, low hood, tall muscular cabin
      return [
        [-halfL * 0.94, -h * 0.2],
        [-halfL * 0.96, h * 0.28],
        [-halfL * 0.8, h * 0.56],
        [-halfL * 0.5, h * 0.96],
        [-halfL * 0.08, h * 0.98],
        [halfL * 0.24, h * 0.72],
        [halfL * 0.52, h * 0.36],
        [halfL * 0.88, h * 0.22],
        [halfL * 0.96, -h * 0.04],
        [halfL * 0.88, -h * 0.2],
      ];
    case 'striker': // Dominus: long, low, wide muscle/GT coupe with sloped fastback roof
      return [
        [-halfL * 0.98, -h * 0.22],
        [-halfL * 0.96, h * 0.34],
        [-halfL * 0.62, h * 0.44],
        [-halfL * 0.36, h * 0.78],
        [halfL * 0.02, h * 0.82],
        [halfL * 0.34, h * 0.44],
        [halfL * 0.86, h * 0.22],
        [halfL * 0.98, 0.04],
        [halfL * 0.94, -h * 0.22],
      ];
    case 'hyperion': // Hypercar: sleek, low futuristic teardrop wedge
      return [
        [-halfL * 0.98, -h * 0.22],
        [-halfL * 0.94, h * 0.28],
        [-halfL * 0.54, h * 0.52],
        [-halfL * 0.14, h * 0.68],
        [halfL * 0.28, h * 0.52],
        [halfL * 0.7, h * 0.22],
        [halfL * 0.98, h * 0.02],
        [halfL * 0.94, -h * 0.22],
      ];
    case 'bullitt':
      return [
        [-halfL * 0.98, -h * 0.22],
        [-halfL * 0.96, h * 0.4],
        [-halfL * 0.56, h * 0.46],
        [-halfL * 0.34, h * 0.88],
        [halfL * 0.12, h * 0.88],
        [halfL * 0.38, h * 0.48],
        [halfL * 0.92, h * 0.34],
        [halfL * 0.98, -h * 0.2],
      ];
    case 'rallyx':
      return [
        [-halfL * 0.94, -h * 0.2],
        [-halfL * 0.9, h * 0.84],
        [-halfL * 0.34, h * 0.96],
        [halfL * 0.16, h * 0.9],
        [halfL * 0.48, h * 0.42],
        [halfL * 0.92, h * 0.22],
        [halfL * 0.95, -h * 0.2],
      ];
    case 'apex_s':
      return [
        [-halfL * 0.98, -h * 0.22],
        [-halfL * 0.94, h * 0.38],
        [-halfL * 0.52, h * 0.54],
        [-halfL * 0.16, h * 0.8],
        [halfL * 0.24, h * 0.72],
        [halfL * 0.62, h * 0.32],
        [halfL * 0.98, h * 0.08],
        [halfL * 0.95, -h * 0.22],
      ];
    case 'formula':
      return [
        [-halfL * 0.98, -h * 0.2],
        [-halfL * 0.88, h * 0.52],
        [-halfL * 0.25, h * 0.68],
        [halfL * 0.12, h * 0.44],
        [halfL * 0.74, h * 0.2],
        [halfL * 0.98, 0.0],
        [halfL * 0.92, -h * 0.22],
      ];
    case 'juggernaut':
      return [
        [-halfL * 0.98, -h * 0.18],
        [-halfL * 0.96, h * 0.72],
        [-halfL * 0.48, h * 0.76],
        [-halfL * 0.28, h * 1.06],
        [halfL * 0.34, h * 1.04],
        [halfL * 0.56, h * 0.56],
        [halfL * 0.96, h * 0.38],
        [halfL * 0.98, -h * 0.18],
      ];
    case 'volt':
      return [
        [-halfL * 0.98, -h * 0.22],
        [-halfL * 0.9, h * 0.48],
        [-halfL * 0.32, h * 0.86],
        [halfL * 0.2, h * 0.82],
        [halfL * 0.64, h * 0.38],
        [halfL * 0.98, h * 0.14],
        [halfL * 0.94, -h * 0.22],
      ];
    case 'drift':
    default:
      return [
        [-halfL * 0.96, -h * 0.22],
        [-halfL * 0.94, h * 0.42],
        [-halfL * 0.44, h * 0.84],
        [halfL * 0.06, h * 0.84],
        [halfL * 0.42, h * 0.38],
        [halfL * 0.96, h * 0.16],
        [halfL * 0.94, -h * 0.22],
      ];
  }
}

export function createCarModel(
  customization: CarCustomization,
  options?: { enablePointLights?: boolean; teamColorHex?: string }
): CarMeshHandle {
  const def = CAR_MAP[customization.carId] ?? CAR_MAP.nomad;
  const { width, height, length, wheelRadius, wheelWidth } = def.dimensions;
  const halfL = length * 0.5;
  const halfW = width * 0.5;
  const accentHex = options?.teamColorHex ?? customization.secondaryColor;

  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const geometriesToDispose: THREE.BufferGeometry[] = [];
  const materialsToDispose: THREE.Material[] = [];
  const texturesToDispose: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometriesToDispose.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materialsToDispose.push(m);
    return m;
  };

  const shared = getSharedCarTextures();
  let liveryTex = createCarLiveryTexture(
    customization.primaryColor,
    customization.secondaryColor,
    customization.carId,
    4
  );
  texturesToDispose.push(liveryTex);

  // 1. PBR Materials
  const primaryMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: liveryTex,
      normalMap: shared.flakeNormal,
      normalScale: new THREE.Vector2(0.28, 0.28),
      metalness: 0.78,
      roughness: 0.27,
      clearcoat: 1.0,
      clearcoatRoughness: 0.055,
      envMapIntensity: 1.4,
    })
  );
  const paintRimCtrl = applyFresnelRimShader(primaryMat, accentHex, 3.0, 0.42);

  const secondaryMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(customization.secondaryColor),
      normalMap: shared.flakeNormal,
      normalScale: new THREE.Vector2(0.18, 0.18),
      metalness: 0.65,
      roughness: 0.26,
      clearcoat: 0.9,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.25,
    })
  );

  const carbonMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: shared.carbon,
      metalness: 0.28,
      roughness: 0.34,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18,
      envMapIntensity: 1.1,
    })
  );

  const brushedMetalMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xdbe4ef,
      map: shared.brushed,
      metalness: 0.92,
      roughness: 0.22,
      anisotropy: 0.75,
      envMapIntensity: 1.35,
    })
  );

  const darkInteriorMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x06080d,
      metalness: 0.2,
      roughness: 0.78,
    })
  );

  const seamMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x05070b,
      roughness: 0.85,
      metalness: 0.15,
    })
  );

  const glassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x091322,
      metalness: 0.14,
      roughness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.6,
      opacity: 0.84,
      transparent: true,
    })
  );

  const headlightMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xe0f2fe,
      emissiveIntensity: 2.1,
      roughness: 0.1,
    })
  );

  const taillightMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff2233,
      emissive: 0xef4444,
      emissiveIntensity: 1.8,
      roughness: 0.15,
    })
  );

  const accentGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(accentHex),
      emissive: new THREE.Color(accentHex),
      emissiveIntensity: 1.45,
      roughness: 0.18,
    })
  );

  const tireMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x16191f,
      normalMap: shared.treadNormal,
      normalScale: new THREE.Vector2(0.75, 0.75),
      metalness: 0.06,
      roughness: 0.9,
    })
  );

  // 2. Primary Sculpted Body Silhouette (Smooth spline + beveled extrusion)
  const bodyWidth = customization.carId === 'formula' ? width * 0.44 : width * 0.78;
  const profilePoints = getSculptedProfilePoints(customization.carId, halfL, height);
  const bodyShape = createSmoothProfileShape(profilePoints);
  const bodyGeo = trackGeo(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: bodyWidth,
      curveSegments: 18,
      bevelEnabled: true,
      bevelThickness: 0.14,
      bevelSize: 0.09,
      bevelSegments: 5,
      steps: 1,
    })
  );
  bodyGeo.translate(0, 0, -bodyWidth * 0.5);
  bodyGeo.rotateY(Math.PI * 0.5); // Front faces -Z
  bodyGeo.computeVertexNormals();
  if (bodyGeo.hasAttribute('uv')) {
    bodyGeo.computeTangents();
  }

  const bodyMesh = new THREE.Mesh(bodyGeo, primaryMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.position.y = 0.05;
  bodyGroup.add(bodyMesh);

  // 3. Wide Flared Fenders / Wheel Arches (curved sculpted arches over all 4 wheels)
  const wheelX = halfW - wheelWidth * 0.28;
  const wheelZFront = -halfL * 0.62;
  const wheelZRear = halfL * 0.6;
  const wheelY = -height * 0.28;

  if (customization.carId !== 'formula') {
    const fenderGeo = trackGeo(
      new THREE.TorusGeometry(wheelRadius * 1.18, 0.15, 10, 18, Math.PI * 1.05)
    );
    fenderGeo.rotateY(Math.PI * 0.5);
    for (const side of [-1, 1]) {
      for (const fz of [wheelZFront, wheelZRear]) {
        const fender = new THREE.Mesh(fenderGeo, primaryMat);
        fender.position.set(side * (bodyWidth * 0.52), wheelY + 0.04, fz);
        fender.scale.set(1.15, 0.92, 1.08);
        fender.castShadow = true;
        bodyGroup.add(fender);
      }
    }
  }

  // 4. Sculpted Tinted Glass Canopy + Interior Dark Cockpit Silhouette
  const canopyLen = customization.carId === 'hyperion' ? length * 0.48 : customization.carId === 'striker' ? length * 0.44 : length * 0.4;
  const canopyWid = customization.carId === 'formula' ? 0.52 : bodyWidth * 0.76;
  const canopyH = customization.carId === 'hyperion' ? height * 0.44 : height * 0.46;
  const canopyZ = customization.carId === 'hyperion' ? -0.14 : customization.carId === 'striker' ? 0.18 : 0.16;
  const canopyY = customization.carId === 'hyperion' ? height * 0.52 : height * 0.62;

  const canopyGeo = trackGeo(new THREE.SphereGeometry(0.5, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.55));
  const interiorCore = new THREE.Mesh(canopyGeo, darkInteriorMat);
  interiorCore.scale.set(canopyWid * 0.88, canopyH * 0.84, canopyLen * 0.88);
  interiorCore.position.set(0, canopyY - 0.03, canopyZ);
  bodyGroup.add(interiorCore);

  const canopyMesh = new THREE.Mesh(canopyGeo, glassMat);
  canopyMesh.scale.set(canopyWid, canopyH, canopyLen);
  canopyMesh.position.set(0, canopyY, canopyZ);
  bodyGroup.add(canopyMesh);

  // 5. Carbon-Fiber Undertray, Front Splitter, Side Skirts & Rear Venturi Diffuser
  const undertray = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(width * 0.86, 0.09, length * 0.92)),
    darkInteriorMat
  );
  undertray.position.set(0, -0.18, 0);
  undertray.castShadow = true;
  bodyGroup.add(undertray);

  // Front sculpted carbon splitter + endplates
  const splitterShape = createSmoothProfileShape([
    [-width * 0.48, -0.22],
    [-width * 0.5, 0.14],
    [-width * 0.3, 0.3],
    [width * 0.3, 0.3],
    [width * 0.5, 0.14],
    [width * 0.48, -0.22],
  ]);
  const splitterGeo = trackGeo(
    new THREE.ExtrudeGeometry(splitterShape, {
      depth: 0.06,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    })
  );
  splitterGeo.rotateX(Math.PI * 0.5);
  const splitter = new THREE.Mesh(splitterGeo, carbonMat);
  splitter.position.set(0, -0.14, -halfL + 0.06);
  splitter.castShadow = true;
  bodyGroup.add(splitter);

  // Side skirts + team-colored underglow strips
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.14, 0.08, length * 0.54)),
      carbonMat
    );
    skirt.position.set(side * (halfW * 0.89), -0.15, 0.02);
    bodyGroup.add(skirt);

    const underglow = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.06, 0.04, length * 0.52)),
      accentGlowMat
    );
    underglow.position.set(side * (halfW * 0.85), -0.19, 0.02);
    bodyGroup.add(underglow);

    // Door seam + side intake recess
    const doorSeam = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.025, height * 0.44, 0.025)),
      seamMat
    );
    doorSeam.position.set(side * (bodyWidth * 0.5 + 0.085), height * 0.18, 0.25);
    bodyGroup.add(doorSeam);

    const intake = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.12, height * 0.24, 0.55)),
      darkInteriorMat
    );
    intake.position.set(side * (bodyWidth * 0.5 + 0.05), height * 0.14, 0.55);
    bodyGroup.add(intake);

    // Sculpted side mirrors
    const mirrorArm = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.16, 0.04, 0.06)),
      carbonMat
    );
    mirrorArm.position.set(side * (bodyWidth * 0.52 + 0.08), height * 0.48, -0.35);
    bodyGroup.add(mirrorArm);
    const mirrorCap = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.09, 10, 8)),
      primaryMat
    );
    mirrorCap.scale.set(1.2, 0.72, 1.4);
    mirrorCap.position.set(side * (bodyWidth * 0.52 + 0.16), height * 0.5, -0.32);
    bodyGroup.add(mirrorCap);
  }

  // Rear carbon diffuser with vertical aero strakes
  const diffuserBase = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(width * 0.78, 0.12, 0.34)),
    carbonMat
  );
  diffuserBase.position.set(0, -0.14, halfL - 0.12);
  diffuserBase.rotation.x = -0.18;
  bodyGroup.add(diffuserBase);
  for (let fx = -0.52; fx <= 0.52; fx += 0.26) {
    const strake = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.035, 0.16, 0.3)),
      carbonMat
    );
    strake.position.set(fx, -0.13, halfL - 0.08);
    bodyGroup.add(strake);
  }

  // Hood panel grooves
  for (const side of [-1, 1]) {
    const hoodGroove = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.02, 0.02, length * 0.3)),
      seamMat
    );
    hoodGroove.position.set(side * (bodyWidth * 0.26), height * 0.36, -halfL * 0.52);
    hoodGroove.rotation.x = 0.14;
    bodyGroup.add(hoodGroove);
  }

  // 6. Car-Specific Spoilers, Intakes, & Aero Sculpture
  const addCarbonWing = (yPos: number, zPos: number, span: number, chord = 0.42, pylonH = 0.36) => {
    const wingShape = createSmoothProfileShape([
      [-span * 0.5, -chord * 0.45],
      [-span * 0.48, chord * 0.45],
      [0, chord * 0.52],
      [span * 0.48, chord * 0.45],
      [span * 0.5, -chord * 0.45],
    ]);
    const wingGeo = trackGeo(
      new THREE.ExtrudeGeometry(wingShape, {
        depth: 0.05,
        bevelEnabled: true,
        bevelThickness: 0.015,
        bevelSize: 0.015,
        bevelSegments: 2,
      })
    );
    wingGeo.rotateX(Math.PI * 0.5 + 0.14);
    const wingBlade = new THREE.Mesh(wingGeo, carbonMat);
    wingBlade.position.set(0, yPos, zPos);
    wingBlade.castShadow = true;
    bodyGroup.add(wingBlade);

    // Endplates with team-color trim
    for (const side of [-1, 1]) {
      const endplate = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.04, 0.24, chord * 1.15)),
        carbonMat
      );
      endplate.position.set(side * span * 0.5, yPos - 0.03, zPos);
      bodyGroup.add(endplate);

      const endTrim = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.045, 0.04, chord * 1.05)),
        accentGlowMat
      );
      endTrim.position.set(side * span * 0.5, yPos + 0.07, zPos);
      bodyGroup.add(endTrim);

      const pylon = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.055, pylonH, 0.22)),
        carbonMat
      );
      pylon.position.set(side * span * 0.28, yPos - pylonH * 0.5, zPos + 0.04);
      pylon.rotation.x = -0.18;
      bodyGroup.add(pylon);
    }
  };

  if (customization.carId === 'nomad') {
    // Octane: large multi-element rear wing + roof intake + front twin grille ducts
    addCarbonWing(height * 1.12, halfL - 0.1, width * 0.96, 0.44, 0.54);
    const roofScoop = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.16, 0.22, 0.52, 10)),
      carbonMat
    );
    roofScoop.rotation.x = Math.PI * 0.5;
    roofScoop.position.set(0, height * 1.02, -0.05);
    bodyGroup.add(roofScoop);
  } else if (customization.carId === 'striker') {
    // Dominus: wide GT wing + twin hood aero vents + aggressive power bulge
    addCarbonWing(height * 0.68, halfL - 0.14, width * 0.96, 0.4, 0.34);
    const powerDome = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.38, 12, 10)),
      primaryMat
    );
    powerDome.scale.set(0.95, 0.28, 2.2);
    powerDome.position.set(0, height * 0.38, -halfL * 0.42);
    bodyGroup.add(powerDome);
  } else if (customization.carId === 'hyperion') {
    // Hypercar: dorsal Le Mans shark fin + high active carbon rear wing + curved aero duct
    const fin = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.05, 0.34, 1.25)),
      carbonMat
    );
    fin.position.set(0, height * 0.68, halfL * 0.32);
    bodyGroup.add(fin);
    addCarbonWing(height * 0.82, halfL - 0.14, width * 0.95, 0.42, 0.42);
  } else if (customization.carId === 'bullitt') {
    const blower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.26, 0.72)), brushedMetalMat);
    blower.position.set(0, height * 0.58, -halfL * 0.4);
    bodyGroup.add(blower);
    addCarbonWing(height * 0.66, halfL - 0.16, width * 0.88, 0.3, 0.22);
  } else if (customization.carId === 'rallyx') {
    addCarbonWing(height * 1.05, halfL - 0.14, width * 0.9, 0.38, 0.24);
    const scoop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.36, 0.14, 0.48)), carbonMat);
    scoop.position.set(0, height * 1.0, 0.05);
    bodyGroup.add(scoop);
  } else if (customization.carId === 'formula') {
    const frontWing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(width * 1.04, 0.07, 0.52)), carbonMat);
    frontWing.position.set(0, -0.1, -halfL + 0.14);
    bodyGroup.add(frontWing);
    addCarbonWing(height * 0.94, halfL - 0.14, width * 0.92, 0.46, 0.42);
    const halo = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.32, 0.042, 8, 16, Math.PI)), carbonMat);
    halo.rotation.x = Math.PI * 0.5;
    halo.position.set(0, height * 0.8, -0.14);
    bodyGroup.add(halo);
  } else if (customization.carId === 'juggernaut') {
    const bullbar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(width * 0.96, 0.42, 0.22)), brushedMetalMat);
    bullbar.position.set(0, 0.02, -halfL - 0.04);
    bodyGroup.add(bullbar);
  } else {
    addCarbonWing(height * 0.84, halfL - 0.15, width * 0.94, 0.38, 0.36);
  }

  // 7. Glowing LED Headlights & LED Strip Taillights
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.36, 0.09, 0.1)), headlightMat);
    hl.position.set(side * (bodyWidth * 0.35), 0.14, -halfL + 0.04);
    hl.rotation.y = side * -0.16;
    bodyGroup.add(hl);

    const drl = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.38, 0.035, 0.11)), accentGlowMat);
    drl.position.set(side * (bodyWidth * 0.35), 0.07, -halfL + 0.04);
    drl.rotation.y = side * -0.16;
    bodyGroup.add(drl);
  }

  // Full-width LED taillight bar
  const tailBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(bodyWidth * 0.84, 0.08, 0.1)), taillightMat);
  tailBar.position.set(0, 0.25, halfL - 0.02);
  bodyGroup.add(tailBar);

  // Hood stripe proxy for optional hood-cam mode
  const hoodStripeMesh = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(width * 0.22, 0.03, length * 0.32)),
    secondaryMat
  );
  hoodStripeMesh.position.set(0, height * 0.38, -halfL * 0.55);
  hoodStripeMesh.rotation.x = 0.14;
  hoodStripeMesh.visible = false;
  bodyGroup.add(hoodStripeMesh);

  // 8. Brushed-Metal Lathe Exhaust Pipes + Custom Shader Boost Flames
  const trailDef = BOOST_TRAIL_CATALOG.find((t) => t.id === customization.boostTrail) ?? BOOST_TRAIL_CATALOG[0];
  const flameShaderMat = trackMat(
    createBoostFlameShaderMaterial(trailDef.coreColor, trailDef.outerColor)
  );

  // Tapered nozzle lathe profile
  const nozzlePts = [
    new THREE.Vector2(0.11, 0),
    new THREE.Vector2(0.16, 0.04),
    new THREE.Vector2(0.16, 0.24),
    new THREE.Vector2(0.12, 0.28),
    new THREE.Vector2(0.1, 0.02),
  ];
  const nozzleGeo = trackGeo(new THREE.LatheGeometry(nozzlePts, 16));
  nozzleGeo.rotateX(Math.PI * 0.5);

  const flameConeGeo = trackGeo(new THREE.ConeGeometry(0.24, 1.9, 14, 6, true));
  flameConeGeo.translate(0, -0.95, 0);
  flameConeGeo.rotateX(-Math.PI * 0.5);

  const flameMeshes: THREE.Mesh[] = [];
  const exhaustOffsets = customization.carId === 'formula' ? [0] : [-0.36, 0.36];

  for (const ex of exhaustOffsets) {
    const nozzle = new THREE.Mesh(nozzleGeo, brushedMetalMat);
    nozzle.position.set(ex, 0.02, halfL - 0.04);
    bodyGroup.add(nozzle);

    const flame = new THREE.Mesh(flameConeGeo, flameShaderMat);
    flame.position.set(ex, 0.02, halfL + 0.14);
    flame.visible = false;
    bodyGroup.add(flame);
    flameMeshes.push(flame);
  }

  let boostLight: THREE.PointLight | null = null;
  if (options?.enablePointLights) {
    boostLight = new THREE.PointLight(new THREE.Color(trailDef.outerColor), 0, 14, 2);
    boostLight.position.set(0, 0.25, halfL + 0.8);
    bodyGroup.add(boostLight);
  }

  // 9. High-Detail Sculpted Wheels (Beveled Tread Tire + 8-Spoke Concave Alloy Rim + Brake Disc + Glowing Rim Ring)
  const wheelSteerPivots: THREE.Group[] = [];
  const wheelSpinGroups: THREE.Group[] = [];

  const wheelConfigs = [
    { x: -wheelX, z: wheelZFront, isFront: true, sideSign: -1 },
    { x: wheelX, z: wheelZFront, isFront: true, sideSign: 1 },
    { x: -wheelX, z: wheelZRear, isFront: false, sideSign: -1 },
    { x: wheelX, z: wheelZRear, isFront: false, sideSign: 1 },
  ];

  // Beveled tire cross-section via LatheGeometry
  const hwTire = wheelWidth * 0.5;
  const rInner = wheelRadius * 0.63;
  const rOuter = wheelRadius;
  const tireProfile = [
    new THREE.Vector2(rInner, -hwTire * 0.88),
    new THREE.Vector2(rOuter * 0.94, -hwTire),
    new THREE.Vector2(rOuter, -hwTire * 0.72),
    new THREE.Vector2(rOuter, hwTire * 0.72),
    new THREE.Vector2(rOuter * 0.94, hwTire),
    new THREE.Vector2(rInner, hwTire * 0.88),
    new THREE.Vector2(rInner, -hwTire * 0.88),
  ];
  const tireGeo = trackGeo(new THREE.LatheGeometry(tireProfile, 26));
  tireGeo.rotateZ(Math.PI * 0.5);

  // Concave alloy rim barrel
  const rimBarrelGeo = trackGeo(
    new THREE.CylinderGeometry(wheelRadius * 0.64, wheelRadius * 0.64, wheelWidth * 0.82, 22, 1, true)
  );
  rimBarrelGeo.rotateZ(Math.PI * 0.5);

  const hubGeo = trackGeo(
    new THREE.CylinderGeometry(wheelRadius * 0.19, wheelRadius * 0.19, wheelWidth * 0.92, 12)
  );
  hubGeo.rotateZ(Math.PI * 0.5);

  // 8 sculpted spokes
  const spokeGeo = trackGeo(new THREE.BoxGeometry(0.045, wheelRadius * 0.56, 0.055));

  // Inner brake disc & caliper
  const rotorGeo = trackGeo(
    new THREE.CylinderGeometry(wheelRadius * 0.46, wheelRadius * 0.46, 0.04, 20)
  );
  rotorGeo.rotateZ(Math.PI * 0.5);

  const caliperGeo = trackGeo(new THREE.BoxGeometry(0.08, wheelRadius * 0.28, wheelRadius * 0.2));

  // Team-colored glowing rim ring
  const rimRingGeo = trackGeo(new THREE.TorusGeometry(wheelRadius * 0.62, 0.022, 8, 28));
  rimRingGeo.rotateY(Math.PI * 0.5);

  for (const wc of wheelConfigs) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(wc.x, wheelY, wc.z);
    root.add(steerPivot);
    if (wc.isFront) {
      wheelSteerPivots.push(steerPivot);
    }

    // Non-spinning brake caliper attached to steer pivot
    const caliper = new THREE.Mesh(caliperGeo, accentGlowMat);
    caliper.position.set(wc.sideSign * (wheelWidth * 0.05), wheelRadius * 0.25, -wheelRadius * 0.18);
    steerPivot.add(caliper);

    const spinGroup = new THREE.Group();
    steerPivot.add(spinGroup);
    wheelSpinGroups.push(spinGroup);

    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    spinGroup.add(tire);

    const rimBarrel = new THREE.Mesh(rimBarrelGeo, darkInteriorMat);
    spinGroup.add(rimBarrel);

    const rotor = new THREE.Mesh(rotorGeo, brushedMetalMat);
    rotor.position.x = -wc.sideSign * (wheelWidth * 0.06);
    spinGroup.add(rotor);

    const hub = new THREE.Mesh(hubGeo, brushedMetalMat);
    spinGroup.add(hub);

    const rimRing = new THREE.Mesh(rimRingGeo, accentGlowMat);
    rimRing.position.x = wc.sideSign * (wheelWidth * 0.43);
    spinGroup.add(rimRing);

    // 8 spokes arranged radially
    const spokeCount = 8;
    for (let s = 0; s < spokeCount; s++) {
      const ang = (s / spokeCount) * Math.PI * 2;
      const spoke = new THREE.Mesh(spokeGeo, brushedMetalMat);
      const rMid = wheelRadius * 0.36;
      spoke.position.set(
        wc.sideSign * (wheelWidth * 0.34),
        Math.cos(ang) * rMid,
        Math.sin(ang) * rMid
      );
      spoke.rotation.x = -ang;
      spoke.rotation.z = wc.sideSign * -0.18;
      spinGroup.add(spoke);
    }
  }

  // 10. Rear-Deck Car Accessories
  const accessoryGroups: Record<string, THREE.Group> = {};
  const deckY = height * 0.88;
  const deckZ = halfL * 0.28;

  const goldMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xfbbf24,
      metalness: 0.94,
      roughness: 0.14,
      clearcoat: 0.8,
    })
  );

  const crownGroup = new THREE.Group();
  crownGroup.position.set(0, deckY + 0.14, deckZ - 0.1);
  crownGroup.add(new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.26, 0.22, 0.14, 10)), goldMat));
  for (let p = 0; p < 5; p++) {
    const a = (p / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.055, 0.18, 6)), goldMat);
    spike.position.set(Math.cos(a) * 0.19, 0.14, Math.sin(a) * 0.19);
    crownGroup.add(spike);
  }
  bodyGroup.add(crownGroup);
  accessoryGroups.crown = crownGroup;

  const haloGroup = new THREE.Group();
  haloGroup.position.set(0, deckY + 0.28, deckZ - 0.15);
  const haloMesh = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.38, 0.045, 10, 28)), headlightMat);
  haloMesh.rotation.x = Math.PI * 0.5;
  haloGroup.add(haloMesh);
  bodyGroup.add(haloGroup);
  accessoryGroups.halo = haloGroup;

  const finGroup = new THREE.Group();
  finGroup.position.set(0, deckY + 0.06, deckZ + 0.12);
  const dorsalFin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.34, 0.85)), carbonMat);
  dorsalFin.rotation.x = -0.15;
  finGroup.add(dorsalFin);
  bodyGroup.add(finGroup);
  accessoryGroups.shark_fin = finGroup;

  const podGroup = new THREE.Group();
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.11, 0.14, 0.62, 12)), brushedMetalMat);
    pod.rotation.x = Math.PI * 0.5;
    pod.position.set(side * (bodyWidth * 0.38), deckY - 0.08, deckZ + 0.18);
    podGroup.add(pod);
    const tip = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.08, 0.08, 0.08, 10)), headlightMat);
    tip.rotation.x = Math.PI * 0.5;
    tip.position.set(side * (bodyWidth * 0.38), deckY - 0.08, deckZ - 0.14);
    podGroup.add(tip);
  }
  bodyGroup.add(podGroup);
  accessoryGroups.rocket_pod = podGroup;

  const antGroup = new THREE.Group();
  for (const side of [-1, 1]) {
    const mast = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.015, 0.024, 0.72, 6)), carbonMat);
    mast.position.set(side * (bodyWidth * 0.38), deckY + 0.18, halfL * 0.72);
    mast.rotation.x = -0.22;
    antGroup.add(mast);
    const orb = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.05, 8, 8)), accentGlowMat);
    orb.position.set(side * (bodyWidth * 0.38), deckY + 0.52, halfL * 0.72 - 0.08);
    antGroup.add(orb);
  }
  bodyGroup.add(antGroup);
  accessoryGroups.antennas = antGroup;

  let currentAccessory = customization.accessory ?? 'none';
  let inFirstPerson = false;
  const syncAccessories = () => {
    for (const [accId, grp] of Object.entries(accessoryGroups)) {
      grp.visible = !inFirstPerson && accId === currentAccessory;
    }
  };
  syncAccessories();

  return {
    root,
    bodyGroup,
    wheelSteerPivots,
    wheelSpinGroups,
    flameMeshes,
    boostLight,
    updateAppearance(next: CarCustomization, nextTeamHex?: string) {
      const nextLivery = createCarLiveryTexture(next.primaryColor, next.secondaryColor, next.carId, 4);
      texturesToDispose.push(nextLivery);
      primaryMat.map = nextLivery;
      primaryMat.needsUpdate = true;

      secondaryMat.color.set(next.secondaryColor);
      const teamAcc = nextTeamHex ?? next.secondaryColor;
      accentGlowMat.color.set(teamAcc);
      accentGlowMat.emissive.set(teamAcc);
      paintRimCtrl.setRimColor(teamAcc);

      const t = BOOST_TRAIL_CATALOG.find((item) => item.id === next.boostTrail) ?? BOOST_TRAIL_CATALOG[0];
      flameShaderMat.uniforms.uCoreColor.value.set(t.coreColor);
      flameShaderMat.uniforms.uOuterColor.value.set(t.outerColor);
      if (boostLight) {
        boostLight.color.set(t.outerColor);
      }
      currentAccessory = next.accessory ?? 'none';
      syncAccessories();
    },
    updateDynamicState({ steerAngle, wheelSpin, isBoosting, throttle, time }) {
      for (const p of wheelSteerPivots) {
        p.rotation.y = steerAngle;
      }
      for (const w of wheelSpinGroups) {
        w.rotation.x = -wheelSpin;
      }
      taillightMat.emissiveIntensity = throttle < -0.1 ? 3.2 : 1.5;

      flameShaderMat.uniforms.uTime.value = time;
      const flicker = 0.88 + Math.sin(time * 46) * 0.14 + Math.cos(time * 71) * 0.08;
      flameShaderMat.uniforms.uIntensity.value = isBoosting ? 1.1 * flicker : 0;

      for (let i = 0; i < flameMeshes.length; i++) {
        const fm = flameMeshes[i];
        fm.visible = isBoosting;
        if (isBoosting) {
          fm.scale.set(0.95 + (flicker - 1) * 0.25, 0.95 + (flicker - 1) * 0.25, flicker);
        }
      }
      if (boostLight) {
        boostLight.intensity = isBoosting ? 4.2 * flicker : 0;
      }
      if (haloGroup.visible) {
        haloGroup.position.y = deckY + 0.28 + Math.sin(time * 3.5) * 0.03;
      }
    },
    setFirstPersonMode(enabled: boolean) {
      inFirstPerson = enabled;
      canopyMesh.visible = !enabled;
      interiorCore.visible = !enabled;
      hoodStripeMesh.visible = enabled;
      syncAccessories();
    },
    dispose() {
      geometriesToDispose.forEach((g) => g.dispose());
      materialsToDispose.forEach((m) => m.dispose());
      texturesToDispose.forEach((t) => t.dispose());
    },
  };
}

export function getTrailColors(trailId: BoostTrailId): { core: string; outer: string } {
  const t = BOOST_TRAIL_CATALOG.find((item) => item.id === trailId) ?? BOOST_TRAIL_CATALOG[0];
  return { core: t.coreColor, outer: t.outerColor };
}
