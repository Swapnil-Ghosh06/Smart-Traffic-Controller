// ============================================================
// SmartSignal Engine v4.0 — Left-Hand Traffic (Indian Style)
// ============================================================
// ROAD GEOMETRY (left-hand traffic, bird's eye, center=0,0):
//
//   NORTH ARM (z<0):
//     Incoming (going SOUTH, dir+z): x = -14, -42  (left side of road = west half)
//     Outgoing (going NORTH, dir-z): x = +14, +42  (right side = east half) [visual only]
//
//   SOUTH ARM (z>0):
//     Incoming (going NORTH, dir-z): x = +14, +42  (left side = east half)
//     Outgoing (going SOUTH, dir+z): x = -14, -42  [visual only]
//
//   EAST ARM (x>0):
//     Incoming (going WEST, dir-x): z = -14, -42   (left side = south half)
//     Outgoing (going EAST, dir+x): z = +14, +42   [visual only]
//
//   WEST ARM (x<0):
//     Incoming (going EAST, dir+x): z = +14, +42   (left side = north half)
//     Outgoing (going WEST, dir-x): z = -14, -42   [visual only]
//
// LANE_HALF = 14, LANE_FULL = 28
// Incoming lane 0 (near center divider): offset = ±14
// Incoming lane 1 (far from divider):    offset = ±42
// ============================================================

// ---- WORLD CONSTANTS ----
const W = {
  ROAD_HALF:     56,     // Half road width (total = 112). Keeps cars tight & realistic
  LANE_W:        26,     // Each lane width
  LANE_HALF:     13,     // Half lane width (= LANE_W/2)
  STOP_DIST:     80,     // Distance from center to stop line
  SPAWN_DIST:    520,    // Distance from center where cars spawn
  CAR_L:         16,     // Physical car length
  CAR_W:         10,     // Physical car width
  CAR_GAP:       8,      // Min bumper-to-bumper gap when stopped
  BASE_SPEED:    1.0,    // Base max speed (world units/frame at simSpeed=1)
  ACCEL:         0.03,   // Smooth acceleration
  DECEL:         0.10,   // Deceleration (stronger than accel = realistic)
  MAX_CARS:      12,     // Max active cars per approach (both lanes)
  DUMB_CYCLE:    30,
  SMART_MIN:     12,
  SMART_MAX:     40,
  YELLOW_DUR:    3,
  LOGIC_TICK:    600,
  DENSITY_TH:    3,
  CO2_PER_IDLE:  2.3,
  FUEL_PER_IDLE: 0.00017,
  SPAWN_INTERVAL:2000,
};

// ---- LEFT-HAND LANE DEFINITIONS ----
// For each direction + subLane (0=inner/nearer center divider, 1=outer)
// Returns: { lateralPos, primaryStart, primaryEnd, primaryStop, primaryAxis, dirSign }
function getLaneDef(dir, subLane) {
  // Inner lane: 1×LANE_HALF from road center. Outer lane: 3×LANE_HALF from road center.
  const innerOff = W.LANE_HALF;       // 13
  const outerOff = W.LANE_HALF * 3;   // 39
  const offs = [innerOff, outerOff];
  const off = offs[subLane];

  switch (dir) {
    case 'N': // Arm goes north (z<0). Incoming traffic travels SOUTH (+z). Left side = negative X.
      return { lat: -off, start: -W.SPAWN_DIST, end: W.SPAWN_DIST, stop: -W.STOP_DIST, axis: 'z', sign: +1 };

    case 'S': // Arm goes south (z>0). Incoming traffic travels NORTH (-z). Left side = positive X.
      return { lat: +off, start: +W.SPAWN_DIST, end: -W.SPAWN_DIST, stop: +W.STOP_DIST, axis: 'z', sign: -1 };

    case 'E': // Arm goes east (x>0). Incoming traffic travels WEST (-x). Left side = negative Z.
      return { lat: -off, start: +W.SPAWN_DIST, end: -W.SPAWN_DIST, stop: +W.STOP_DIST, axis: 'x', sign: -1 };

    case 'W': // Arm goes west (x<0). Incoming traffic travels EAST (+x). Left side = positive Z.
      return { lat: +off, start: -W.SPAWN_DIST, end: +W.SPAWN_DIST, stop: -W.STOP_DIST, axis: 'x', sign: +1 };
  }
}

// ---- IS NORTH/SOUTH DIRECTION ----
function isNS(dir) { return dir === 'N' || dir === 'S'; }

// ---- STATE ----
const state = {
  simSpeed: 1,
  density: 5,
  running: true,
  pedestrianActive: false,
  pedestrianTimer: 0,
  startTime: Date.now(),
  emergencyTimeout: null,
  activeMode: 'dumb',
};

const logic = {
  sensors: { D_N:0, D_S:0, D_E:0, D_W:0, A_N:0, A_S:0, A_E:0, A_W:0, P:0, T:0 },
  flipFlop: { S:0, R:0, Q:0 },
  boolExpr: '',
  activeRow: 0,
  greenTime: 0,
  liveReason: 'Initializing...',
};

function createModeState() {
  return {
    phase: 'NS',
    phaseTimer: W.DUMB_CYCLE,
    yellowTimer: 0,
    isYellow: false,
    nextPhase: null,
    lights: { N:'green', S:'green', E:'red', W:'red' },
    // cars[dir][subLane] = array of car objects
    cars: { N:[[],[]], S:[[],[]], E:[[],[]], W:[[],[]] },
    cleared: 0,
    totalWaitTime: 0,
    totalCarsWaited: 0,
    ambulanceDelayTotal: 0,
    ambulanceCount: 0,
    co2: 0,
    fuel: 0,
    idlingCars: 0,
  };
}

let dumb  = createModeState();
let smart = createModeState();
let dumbThree, smartThree;
let _carId = 0;

// ---- CAR FACTORY ----
const CAR_COLORS = [
  0xd0d8f0, // silver-white
  0x4488cc, // blue
  0xccaa33, // gold
  0x778899, // steel gray
  0xcc4444, // dark red
  0x55aa77, // sage green
  0xee8833, // orange
  0x9988bb, // purple
];

function createCar(dir, subLane, type = 'car') {
  const lane = getLaneDef(dir, subLane);
  const speedMult = type === 'bus' ? 0.6 :
                    type === 'ambulance' ? 1.35 :
                    0.75 + Math.random() * 0.45; // human variation ±30%

  const maxSpd = W.BASE_SPEED * speedMult;

  // Human-like variation: each driver has own accel/decel
  const accel = W.ACCEL * (0.8 + Math.random() * 0.4);
  const decel = W.DECEL * (0.85 + Math.random() * 0.3);

  // Small random offset within lane (human lateral variation, max ±3 units)
  const latOffset = (Math.random() - 0.5) * 6;

  // Preferred following distance (varies per driver)
  const prefGap = W.CAR_GAP * (1.0 + Math.random() * 1.0);

  const color = type === 'ambulance' ? 0xff2244 :
                type === 'bus'       ? 0xddaa00 :
                CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];

  const carL = W.CAR_L * (type === 'bus' ? 1.6 : type === 'ambulance' ? 1.2 : 1);
  const carW = W.CAR_W * (type === 'bus' ? 1.35 : 1);

  return {
    id: _carId++,
    dir, subLane, type,
    lane,           // lane definition (fixed for lifetime)
    lat: lane.lat + latOffset, // lateral position (fixed, with small offset)
    pos: lane.start, // primary axis position
    speed: maxSpd * 0.3, // start slow
    maxSpeed: maxSpd,
    accel, decel,
    prefGap,
    carL, carW,
    color,
    waiting: false,
    waitTime: 0,
    passed: false,          // has crossed stop line
    inIntersection: false,
  };
}

// ---- AGGREGATE CAR LISTS ----
function allCarsInDir(mode, dir) {
  return mode.cars[dir][0].concat(mode.cars[dir][1]);
}

// ============================================================
// TRAFFIC LIGHT LOGIC
// ============================================================
function setLights(mode) {
  if (state.pedestrianActive) {
    mode.lights = { N:'red', S:'red', E:'red', W:'red' };
    return;
  }
  const y = mode.isYellow;
  if (mode.phase === 'NS') {
    mode.lights = { N:y?'yellow':'green', S:y?'yellow':'green', E:'red', W:'red' };
  } else {
    mode.lights = { N:'red', S:'red', E:y?'yellow':'green', W:y?'yellow':'green' };
  }
}

function updateDumbController(dt) {
  if (state.pedestrianActive) { setLights(dumb); return; }
  const el = (dt / 1000) * state.simSpeed;
  dumb.phaseTimer -= el;
  if (dumb.phaseTimer <= 0) {
    if (!dumb.isYellow) {
      dumb.isYellow = true;
      dumb.yellowTimer = W.YELLOW_DUR;
      dumb.phaseTimer  = W.YELLOW_DUR;
    } else {
      dumb.isYellow = false;
      dumb.phase = dumb.phase === 'NS' ? 'EW' : 'NS';
      dumb.phaseTimer = W.DUMB_CYCLE;
    }
  }
  setLights(dumb);
}

function updateSmartController() {
  if (smart.isYellow) return;

  const cnt = (dir) => allCarsInDir(smart, dir).filter(c => !c.passed).length;
  const n = cnt('N'), s = cnt('S'), e = cnt('E'), w = cnt('W');

  const hasAmb = (dir) => allCarsInDir(smart, dir).some(c => !c.passed && c.type === 'ambulance');
  logic.sensors.A_N = hasAmb('N')?1:0; logic.sensors.A_S = hasAmb('S')?1:0;
  logic.sensors.A_E = hasAmb('E')?1:0; logic.sensors.A_W = hasAmb('W')?1:0;
  logic.sensors.D_N = n >= W.DENSITY_TH?1:0; logic.sensors.D_S = s >= W.DENSITY_TH?1:0;
  logic.sensors.D_E = e >= W.DENSITY_TH?1:0; logic.sensors.D_W = w >= W.DENSITY_TH?1:0;
  logic.sensors.P = state.pedestrianActive ? 1 : 0;

  const nsEmpty = n===0&&s===0, ewEmpty = e===0&&w===0;
  logic.sensors.T = (smart.phaseTimer<=0 ||
    (smart.phase==='NS' && nsEmpty && !ewEmpty) ||
    (smart.phase==='EW' && ewEmpty && !nsEmpty)) ? 1 : 0;

  const L = logic.sensors;
  let sv=0, rv=0, expr='';

  if (L.A_N||L.A_S)      { sv=0; rv=1; expr='EMERGENCY_NS'; logic.greenTime=W.SMART_MIN; }
  else if (L.A_E||L.A_W) { sv=1; rv=0; expr='EMERGENCY_EW'; logic.greenTime=W.SMART_MIN; }
  else if (L.P)           { expr='PEDESTRIAN'; }
  else if (L.T) {
    const dns=n+s, dew=e+w;
    if (dns >= dew && (L.D_N||L.D_S))      { sv=0; rv=1; expr='D_NS≥D_EW'; logic.greenTime=Math.min(W.SMART_MAX,dns*3); }
    else if (L.D_E||L.D_W)                  { sv=1; rv=0; expr='D_EW>D_NS'; logic.greenTime=Math.min(W.SMART_MAX,dew*3); }
    else if (smart.phase==='NS')             { sv=1; rv=0; expr='TIMER_ROTATE'; logic.greenTime=W.SMART_MIN; }
    else                                     { sv=0; rv=1; expr='TIMER_ROTATE'; logic.greenTime=W.SMART_MIN; }
  }

  logic.flipFlop.S=sv; logic.flipFlop.R=rv;
  if (sv===1&&rv===0) logic.flipFlop.Q=1;
  if (sv===0&&rv===1) logic.flipFlop.Q=0;

  const newPhase = logic.flipFlop.Q===0 ? 'NS' : 'EW';
  logic.boolExpr = `GREEN = ${expr}`;
  logic.liveReason =
    expr.includes('EMERGENCY') ? 'Emergency Vehicle Override Active' :
    expr.includes('PEDESTRIAN') ? 'Pedestrian Crossing Phase' :
    expr.includes('TIMER_ROTATE') ? 'Timer Cycle Rotation' :
    (expr.includes('D_NS')||expr.includes('D_EW')) ? 'High Density Priority Active' :
    'Balancing traffic density.';

  if (state.pedestrianActive)                    setLights(smart);
  else if (newPhase !== smart.phase && !smart.isYellow) {
    smart.nextPhase = newPhase;
    smart.isYellow = true;
    smart.yellowTimer = W.YELLOW_DUR;
    smart.phaseTimer  = W.YELLOW_DUR;
    setLights(smart);
  } else if (!smart.isYellow)                    setLights(smart);
}

// ============================================================
// VEHICLE PHYSICS UPDATE
// ============================================================
function updateCars(mode, dt) {
  const el = (dt / 1000) * state.simSpeed;
  mode.idlingCars = 0;

  ['N','S','E','W'].forEach(dir => {
    const sig = mode.lights[dir];

    [0, 1].forEach(sl => {
      const lane = getLaneDef(dir, sl);
      const cars = mode.cars[dir][sl];

      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        const pos = car.pos;
        const sign = lane.sign;
        const stopPos = lane.stop;

        // Distance to stop line (positive = still before it)
        const distToStop = (stopPos - pos) * sign;
        const beforeStop = distToStop > 0;

        let targetSpeed = car.maxSpeed;

        // ---- SIGNAL COMPLIANCE ----
        if (!car.passed && beforeStop) {
          if (sig === 'red' || sig === 'yellow') {
            if (distToStop <= 2) {
              // at line — hard stop
              targetSpeed = 0;
              car.speed = 0;
              car.pos = stopPos - sign * 2;
            } else if (distToStop < 60) {
              // brake zone: speed proportional to remaining distance
              targetSpeed = car.maxSpeed * Math.pow(distToStop / 60, 1.5) * 0.5;
            }
          }
        }

        // Mark crossed stop line
        if (!car.passed && !beforeStop) {
          car.passed = true;
          car.inIntersection = true;
        }
        // Clear intersection flag once far enough past center
        if (car.inIntersection && Math.abs(pos) > W.ROAD_HALF + 20) {
          car.inIntersection = false;
        }

        // ---- CAR-FOLLOWING (same sub-lane only) ----
        if (i > 0) {
          const leader = cars[i - 1];
          // gap = signed distance from this car's nose to leader's tail
          const gap = (leader.pos - pos) * sign - leader.carL;
          const minStop  = car.prefGap;
          const brakeAt  = car.prefGap + car.carL * 2.5;

          if (gap <= minStop) {
            // Too close: hard stop, position clamp
            targetSpeed = 0;
            car.speed = 0;
            car.pos = leader.pos - sign * (leader.carL + minStop);
          } else if (gap < brakeAt) {
            const t = (gap - minStop) / (brakeAt - minStop); // 0..1
            targetSpeed = Math.min(targetSpeed, leader.speed * t + 0.02);
          }
        }

        // ---- KINEMATIC INTEGRATION ----
        const eff_accel = car.accel * state.simSpeed;
        const eff_decel = car.decel * state.simSpeed;
        if (targetSpeed < car.speed) {
          car.speed = Math.max(targetSpeed, car.speed - eff_decel);
        } else {
          car.speed = Math.min(targetSpeed, car.speed + eff_accel);
        }
        if (car.speed < 0.005) car.speed = 0;

        // ---- MOVE ----
        car.pos += sign * car.speed * state.simSpeed;

        // ---- WAIT TIME ACCOUNTING ----
        if (car.speed < 0.05 && !car.passed) {
          if (!car.waiting) car.waiting = true;
          car.waitTime += el;
          mode.idlingCars++;
          if (car.type === 'ambulance') mode.ambulanceDelayTotal += el;
        } else if (car.waiting && car.speed > 0.25) {
          car.waiting = false;
          mode.totalWaitTime += car.waitTime;
          mode.totalCarsWaited++;
        }

        // ---- DESPAWN ----
        const endPos = lane.end;
        const pastEnd = (pos - endPos) * sign > 0;
        if (pastEnd) {
          cars.splice(i, 1); i--;
          mode.cleared++;
          if (car.type === 'ambulance') mode.ambulanceCount++;
        }
      }
    });
  });

  mode.co2  += mode.idlingCars * W.CO2_PER_IDLE  * el;
  mode.fuel += mode.idlingCars * W.FUEL_PER_IDLE * el;
}

// ============================================================
// THREE.JS SCENE
// ============================================================
function initThreeJS(canvasId) {
  const canvas = document.getElementById(canvasId);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  renderer.outputEncoding = THREE.sRGBEncoding;

  const W2 = window.innerWidth, H = window.innerHeight;
  renderer.setSize(W2, H);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1220);
  scene.fog = new THREE.FogExp2(0x0a1220, 0.0010);

  const camera = new THREE.PerspectiveCamera(48, W2 / H, 5, 3000);
  camera.position.set(0, 310, 370);
  camera.lookAt(0, 0, 0);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor  = 0.07;
  controls.minPolarAngle  = Math.PI * 0.18;   // ~32°
  controls.maxPolarAngle  = Math.PI * 0.46;   // ~83°
  controls.minDistance    = 100;
  controls.maxDistance    = 850;

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // ---- LIGHTING ----
  scene.add(new THREE.AmbientLight(0x3a5070, 3.5));

  const sun = new THREE.DirectionalLight(0xbbddff, 2.2);
  sun.position.set(180, 450, 220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 5; sun.shadow.camera.far = 1400;
  ['top','bottom','left','right'].forEach((k,i) => sun.shadow.camera[k] = [650,-650,-650,650][i]);
  sun.shadow.bias = -0.001;
  scene.add(sun);
  scene.add(new THREE.DirectionalLight(0x223344, 1.0).position.set(-200, 280, -180));

  buildScene(scene);
  const poles = buildSignalPoles(scene);
  const pedGroup = new THREE.Group();
  scene.add(pedGroup);

  return { scene, camera, renderer, controls, poles, carMeshes: new Map(), pedGroup };
}

// ============================================================
// SCENE BUILDER
// ============================================================
function buildScene(scene) {
  const RH = W.ROAD_HALF;  // 56
  const RL = 1000;         // Road arm visible length

  // Materials
  const mRoad     = new THREE.MeshLambertMaterial({ color: 0x1c2030 });
  const mSidewalk = new THREE.MeshLambertMaterial({ color: 0x2c3245 });
  const mCurb     = new THREE.MeshLambertMaterial({ color: 0x3a4255 });
  const mGround   = new THREE.MeshLambertMaterial({ color: 0x182018 });
  const mWhite    = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 });
  const mYellow   = new THREE.MeshLambertMaterial({ color: 0xeebb00, emissive: 0x332200 });
  const mStopLine = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x888888 });

  const addMesh = (geo, mat, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const plane = (w, d) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI/2); return g; };

  // Ground
  addMesh(plane(5000, 5000), mGround, 0, -0.5, 0);

  // NS road arm
  addMesh(plane(RH*2, RL), mRoad, 0, 0, 0);
  // EW road arm
  addMesh(plane(RL, RH*2), mRoad, 0, 0, 0);

  // Sidewalks (80 wide on each side of NS and EW arms)
  const SW = 70;
  [-1,1].forEach(s => {
    addMesh(plane(SW, RL), mSidewalk, s*(RH + SW/2), 0.02, 0);   // NS sidewalks
    addMesh(plane(RL, SW), mSidewalk, 0, 0.02, s*(RH + SW/2));    // EW sidewalks
  });

  // Corner pads
  [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([sx,sz]) => {
    addMesh(plane(SW+2, SW+2), mSidewalk, sx*(RH+SW/2), 0.02, sz*(RH+SW/2));
  });

  // Curbs
  const CURB_H = 4;
  for (const sign of [-1, 1]) {
    // NS road curbs (along X edges)
    const nc = new THREE.Mesh(new THREE.BoxGeometry(CURB_H, CURB_H, RL), mCurb);
    nc.position.set(sign*RH, CURB_H/2, 0); nc.receiveShadow = true; scene.add(nc);
    // EW road curbs (along Z edges)
    const ec = new THREE.Mesh(new THREE.BoxGeometry(RL, CURB_H, CURB_H), mCurb);
    ec.position.set(0, CURB_H/2, sign*RH); ec.receiveShadow = true; scene.add(ec);
  }

  // ---- CENTER DIVIDERS (yellow double-line) ----
  // NS road center
  for (let z = RH + 20; z < RL/2; z += 28) {
    for (const s of [-1,1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 14), mYellow);
      m.rotation.x = -Math.PI/2; m.position.set(0, 0.08, s*z); scene.add(m);
    }
  }
  // EW road center
  for (let x = RH + 20; x < RL/2; x += 28) {
    for (const s of [-1,1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 2), mYellow);
      m.rotation.x = -Math.PI/2; m.position.set(s*x, 0.08, 0); scene.add(m);
    }
  }

  // ---- LANE DASHES ----
  // NS arm lane divider (between inner and outer lane) at x = ±W.LANE_W = ±26
  for (const lx of [-W.LANE_W, W.LANE_W]) {
    for (let z = RH + 20; z < RL/2; z += 40) {
      for (const s of [-1,1]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 12), mWhite);
        m.rotation.x = -Math.PI/2; m.position.set(lx, 0.07, s*z); scene.add(m);
      }
    }
  }
  // EW arm lane dividers at z = ±26
  for (const lz of [-W.LANE_W, W.LANE_W]) {
    for (let x = RH + 20; x < RL/2; x += 40) {
      for (const s of [-1,1]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(12, 1.2), mWhite);
        m.rotation.x = -Math.PI/2; m.position.set(s*x, 0.07, lz); scene.add(m);
      }
    }
  }

  // ---- STOP LINES (thick white, across full road) ----
  const SD = W.STOP_DIST;
  [
    [0, -SD, RH*2, 4], // North approach
    [0, +SD, RH*2, 4], // South approach
    [+SD, 0, 4, RH*2], // East approach
    [-SD, 0, 4, RH*2], // West approach
  ].forEach(([x,z,w2,d]) => {
    const sl = new THREE.Mesh(new THREE.PlaneGeometry(w2, d), mStopLine);
    sl.rotation.x = -Math.PI/2; sl.position.set(x, 0.15, z); scene.add(sl);
  });

  // ---- ZEBRA CROSSINGS ----
  const ZW = 7, ZH = RH*2;
  const ZOff = SD + 14;
  for (const off of [-ZOff, ZOff]) {
    for (let k = -(RH-5); k < RH; k += 15) {
      const zb = new THREE.Mesh(new THREE.PlaneGeometry(ZW, ZH), mWhite);
      zb.rotation.x = -Math.PI/2; zb.position.set(k, 0.11, off); scene.add(zb);
      const zb2 = new THREE.Mesh(new THREE.PlaneGeometry(ZH, ZW), mWhite);
      zb2.rotation.x = -Math.PI/2; zb2.position.set(off, 0.11, k); scene.add(zb2);
    }
  }

  buildBuildings(scene, RH, SW);
  buildStreetLamps(scene, RH);
  buildTrees(scene, RH, SW);
}

function buildBuildings(scene, RH, SW) {
  const SETBACK = RH + SW + 15;
  const bMat  = new THREE.MeshLambertMaterial({ color: 0x0c111a });
  const wLitA = new THREE.MeshBasicMaterial({ color: 0xffeecc });
  const wLitB = new THREE.MeshBasicMaterial({ color: 0xaae0ff });
  const wOff  = new THREE.MeshLambertMaterial({ color: 0x080c14 });

  [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([sx,sz]) => {
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const bw = 80 + Math.random()*90, bd = 80 + Math.random()*90;
      const bh = 120 + Math.random()*280;
      const bx = sx*(SETBACK + i*150 + Math.random()*25);
      const bz = sz*(SETBACK + Math.random()*50);

      const g = new THREE.Group();
      g.position.set(bx, 0, bz);
      const core = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), bMat);
      core.position.y = bh/2; core.castShadow = true; g.add(core);

      for (let wx = -bw/2+8; wx < bw/2-4; wx += 14) {
        for (let wy = 20; wy < bh-8; wy += 18) {
          const lit = Math.random() < 0.28;
          const wm = lit ? (Math.random()<0.5 ? wLitA : wLitB) : wOff;
          if (Math.random() < 0.8) {
            const fw = new THREE.Mesh(new THREE.PlaneGeometry(9, 12), wm);
            fw.position.set(wx, wy, bd/2+0.1); g.add(fw);
            const bw2 = fw.clone();
            bw2.position.set(wx, wy, -bd/2-0.1); bw2.rotation.y = Math.PI; g.add(bw2);
          }
        }
      }
      scene.add(g);
    }
  });
}

function buildStreetLamps(scene, RH) {
  const pMat = new THREE.MeshLambertMaterial({ color: 0x222233 });
  const gMat = new THREE.MeshBasicMaterial({ color: 0xffeeaa });

  const addLamp = (x, z, aimX) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 55), pMat);
    p.position.y = 27.5; g.add(p);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 16), pMat);
    arm.rotation.z = Math.PI/2; arm.position.set(-aimX*8, 55, 0); g.add(arm);
    const gl = new THREE.Mesh(new THREE.SphereGeometry(2.8), gMat);
    gl.position.set(-aimX*16, 54, 0); g.add(gl);
    scene.add(g);
  };

  for (const sz of [-1,1]) {
    for (let z = 120; z < 480; z += 130) {
      addLamp((RH+18)*1, sz*z, -1);
      addLamp((RH+18)*-1, sz*z, 1);
    }
  }
  for (const sx of [-1,1]) {
    for (let x = 120; x < 480; x += 130) {
      const g = new THREE.Group();
      g.position.set(sx*x, 0, (RH+18));
      const p = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 55), pMat);
      p.position.y = 27.5; g.add(p);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 16), pMat);
      arm.rotation.x = Math.PI/2; arm.position.set(0, 55, -8); g.add(arm);
      const gl = new THREE.Mesh(new THREE.SphereGeometry(2.8), gMat);
      gl.position.set(0, 54, -16); g.add(gl);
      scene.add(g);
      const g2 = g.clone(); g2.position.set(sx*x, 0, -(RH+18)); scene.add(g2);
    }
  }
}

function buildTrees(scene, RH, SW) {
  const tMat  = new THREE.MeshLambertMaterial({ color: 0x2a1a0e });
  const c1Mat = new THREE.MeshLambertMaterial({ color: 0x1a4a1a });
  const c2Mat = new THREE.MeshLambertMaterial({ color: 0x0e3d0a });

  const addTree = (x, z) => {
    const g = new THREE.Group();
    g.position.set(x + (Math.random()-0.5)*8, 0, z + (Math.random()-0.5)*8);
    const h = 20 + Math.random()*14;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.2, h), tMat);
    tr.position.y = h/2; g.add(tr);
    const cm = Math.random()<0.5 ? c1Mat : c2Mat;
    const ca = new THREE.Mesh(new THREE.IcosahedronGeometry(11 + Math.random()*6, 1), cm);
    ca.position.y = h + 6; g.add(ca);
    scene.add(g);
  };

  const SW_C = RH + SW/2;
  for (let z = 140; z < 500; z += 90) {
    for (const s of [-1,1]) {
      if (Math.random() < 0.8) addTree(SW_C * 1, s*z);
      if (Math.random() < 0.8) addTree(SW_C * -1, s*z);
    }
  }
  for (let x = 140; x < 500; x += 90) {
    for (const s of [-1,1]) {
      if (Math.random() < 0.75) addTree(s*x, SW_C);
      if (Math.random() < 0.75) addTree(s*x, -SW_C);
    }
  }
}

// ============================================================
// SIGNAL POLES — one per approach, placed at stop line right side
// ============================================================
function buildSignalPoles(scene) {
  const poles = {};
  const SD = W.STOP_DIST;
  const RH = W.ROAD_HALF;

  const pMat  = new THREE.MeshLambertMaterial({ color: 0x111116 });
  const hMat  = new THREE.MeshLambertMaterial({ color: 0x0a0a0e });

  // Placement: on the RIGHT side of incoming traffic, just before stop line
  // In left-hand traffic the signal is on the LEFT roadside from driver's view
  // With our coordinate system:
  //   N approach (driving south): left side = positive X side
  //   S approach (driving north): left side = negative X side
  //   E approach (driving west): left side = positive Z side
  //   W approach (driving east): left side = negative Z side
  const cfgs = {
    N: { px:  RH - 10, pz: -(SD-2), rotY: Math.PI },         // N: signal faces south
    S: { px: -(RH-10), pz:  (SD-2), rotY: 0 },                // S: signal faces north
    E: { px:  (SD-2),  pz: -(RH-10), rotY: -Math.PI/2 },      // E: signal faces west
    W: { px: -(SD-2),  pz:  (RH-10), rotY:  Math.PI/2 },      // W: signal faces east
  };

  Object.entries(cfgs).forEach(([dir, cfg]) => {
    const grp = new THREE.Group();
    grp.position.set(cfg.px, 0, cfg.pz);
    grp.rotation.y = cfg.rotY;

    // Vertical pole
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 68), pMat);
    pole.position.y = 34; pole.castShadow = true; grp.add(pole);

    // Horizontal arm pointing toward road center
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 24), pMat);
    arm.rotation.z = Math.PI/2; arm.position.set(12, 68, 0); grp.add(arm);

    // Signal housing
    const house = new THREE.Mesh(new THREE.BoxGeometry(10, 36, 10), hMat);
    house.position.set(24, 68, 0); grp.add(house);

    // 3 lights in housing, facing forward (+Z after rotation)
    const lDefs = [
      { name:'red',    on:0xff2233, off:0x2a0508, y: 12 },
      { name:'yellow', on:0xffcc00, off:0x2a2000, y: 0  },
      { name:'green',  on:0x00ff55, off:0x002a10, y:-12 },
    ];
    const lights = {};
    lDefs.forEach(ld => {
      const mat    = new THREE.MeshBasicMaterial({ color: ld.off });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(4, 14, 10), mat);
      sphere.position.set(24, 68 + ld.y, 5.6);
      grp.add(sphere);
      lights[ld.name] = { mesh: sphere, onColor: ld.on, offColor: ld.off };
    });

    scene.add(grp);
    poles[dir] = { lights };
  });

  return poles;
}

// ============================================================
// CAR MESH FACTORY
// ============================================================
function buildCarMesh(car, scene) {
  const grp = new THREE.Group();
  const ns = isNS(car.dir);

  // Physical dims in 3D: car travels along primary axis
  // ns=true → car body: width=X (=carW), length=Z (=carL)
  // ns=false → car body: width=Z, length=X
  const bodyX = ns ? car.carW : car.carL;
  const bodyZ = ns ? car.carL : car.carW;
  const bodyH = car.type==='bus' ? 20 : car.type==='ambulance' ? 17 : 9 + Math.random()*4;

  const paint = new THREE.MeshLambertMaterial({ color: car.color });
  // Chassis (flat slab = 35% of body height)
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(bodyX, 4, bodyZ), paint);
  chassis.position.y = 2; chassis.castShadow = true; grp.add(chassis);

  // Cabin window-box
  const cabMat = new THREE.MeshLambertMaterial({ color: 0x0f1520 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(bodyX*0.78, bodyH-4, bodyZ*0.80), cabMat);
  cab.position.y = 4 + (bodyH-4)/2; cab.castShadow = true; grp.add(cab);

  // Headlights / taillights
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffeecc });
  const rlMat = new THREE.MeshBasicMaterial({ color: 0xff2200 });
  const sign = car.lane.sign;
  // Front face (in direction of travel)
  const fZ = sign > 0 ? bodyZ/2 + 0.3 : -(bodyZ/2) - 0.3;
  const rZ = sign > 0 ? -(bodyZ/2) - 0.3 : bodyZ/2 + 0.3;
  for (const lx of [-bodyX/3, bodyX/3]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2), hlMat);
    hl.position.set(lx, 3, fZ); grp.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2), rlMat);
    tl.position.set(lx, 3, rZ); grp.add(tl);
  }

  // Ambulance: red/blue lightbar on roof
  if (car.type === 'ambulance') {
    const barMat = new THREE.MeshBasicMaterial({ color: 0xff1133 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(bodyX*0.6, 3, 7), barMat);
    bar.position.y = bodyH + 2;
    bar.userData.isLightBar = true;
    grp.add(bar);
  }

  scene.add(grp);
  return grp;
}

// ============================================================
// RENDER FRAME
// ============================================================
function renderFrame(ts, mode) {
  const { scene, camera, renderer, controls, poles, carMeshes, pedGroup } = ts;
  controls.update();

  // ---- Signal lights ----
  ['N','S','E','W'].forEach(dir => {
    const sig = mode.lights[dir];
    const tl  = poles[dir].lights;
    ['red','yellow','green'].forEach(c => {
      tl[c].mesh.material.color.setHex(c === sig ? tl[c].onColor : tl[c].offColor);
    });
  });

  // ---- Sync car meshes ----
  const activeIds = new Set();

  ['N','S','E','W'].forEach(dir => {
    [0, 1].forEach(sl => {
      mode.cars[dir][sl].forEach(car => {
        activeIds.add(car.id);
        let mesh = carMeshes.get(car.id);
        if (!mesh) {
          mesh = buildCarMesh(car, scene);
          carMeshes.set(car.id, mesh);
        }

        // Position: primary axis = Z for NS, X for EW; lateral is the other
        if (isNS(car.dir)) {
          mesh.position.set(car.lat, 0, car.pos);
        } else {
          mesh.position.set(car.pos, 0, car.lat);
        }

        // Ambulance light flicker
        if (car.type === 'ambulance') {
          const flicker = (Math.floor(performance.now() / 200) % 2 === 0) ? 0xff1133 : 0x1133ff;
          mesh.traverse(c => { if (c.userData?.isLightBar) c.material.color.setHex(flicker); });
        }
      });
    });
  });

  // Dispose + remove stale meshes
  for (const [id, mesh] of carMeshes.entries()) {
    if (!activeIds.has(id)) {
      scene.remove(mesh);
      mesh.traverse(c => {
        if (c.isMesh) {
          c.geometry.dispose();
          const m = c.material;
          if (Array.isArray(m)) m.forEach(x => x.dispose()); else m.dispose();
        }
      });
      carMeshes.delete(id);
    }
  }

  // Pedestrians
  if (state.pedestrianActive) {
    if (pedGroup.children.length === 0) {
      const skin = new THREE.MeshLambertMaterial({ color: 0xffccaa });
      // Vivid solid colors for pedestrians
      const VIVID_COLORS = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff6600, 0x33ff00];
      for (let i = 0; i < 6; i++) {
        const pg = new THREE.Group();
        const color = VIVID_COLORS[Math.floor(Math.random() * VIVID_COLORS.length)];
        const sc = new THREE.MeshLambertMaterial({ color: color });
        const body = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 2), sc);
        body.position.y = 6; pg.add(body);
        const h = new THREE.Mesh(new THREE.SphereGeometry(1.5), skin);
        h.position.y = 10; pg.add(h);
        pg.position.set(-(W.ROAD_HALF-8) + i*15, 0, -(W.STOP_DIST+16));
        pg.userData.t = Math.random() * Math.PI * 2;
        pedGroup.add(pg);
      }
    }
    pedGroup.children.forEach(pg => {
      pg.userData.t += 0.05 * state.simSpeed;
      pg.position.x += Math.cos(pg.userData.t) * 0.25;
    });
  } else {
    while (pedGroup.children.length > 0) {
      const c = pedGroup.children[0];
      pedGroup.remove(c);
      c.traverse(ch => { if (ch.isMesh) { ch.geometry.dispose(); ch.material.dispose(); } });
    }
  }

  renderer.render(scene, camera);
}

// ============================================================
// UI UPDATE
// ============================================================
function updateUI() {
  const el = Math.max((Date.now() - state.startTime) / 1000, 1);
  const mins = el / 60;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  set('total-cleared', dumb.cleared + smart.cleared);
  const da = dumb.totalCarsWaited>0 ? dumb.totalWaitTime/dumb.totalCarsWaited : 0;
  const sa = smart.totalCarsWaited>0 ? smart.totalWaitTime/smart.totalCarsWaited : 0;
  set('avg-wait', ((da+sa)/2).toFixed(1)+'s');
  set('fuel-wasted', (dumb.fuel+smart.fuel).toFixed(2)+' L');
  set('lives-risk', dumb.ambulanceCount + (dumb.ambulanceDelayTotal>5?'+':''));
  set('dumb-timer', Math.max(0, dumb.isYellow ? dumb.yellowTimer : dumb.phaseTimer).toFixed(0)+'s');
  set('smart-timer', Math.max(0, smart.isYellow ? smart.yellowTimer : smart.phaseTimer).toFixed(0)+'s');
  set('m-dumb-vpm',  (dumb.cleared/mins).toFixed(1));
  set('m-smart-vpm', (smart.cleared/mins).toFixed(1));
  set('m-dumb-wait',  da.toFixed(1)+'s');
  set('m-smart-wait', sa.toFixed(1)+'s');
  set('m-dumb-amb',  (dumb.ambulanceCount>0?dumb.ambulanceDelayTotal/dumb.ambulanceCount:0).toFixed(1)+'s');
  set('m-smart-amb', (smart.ambulanceCount>0?smart.ambulanceDelayTotal/smart.ambulanceCount:0).toFixed(1)+'s');
  set('m-dumb-co2',  dumb.co2.toFixed(0)+'g');
  set('m-smart-co2', smart.co2.toFixed(0)+'g');
  set('impact-vehicles', Math.max(0, smart.cleared - dumb.cleared));
  set('impact-amb-time', Math.max(0, dumb.ambulanceDelayTotal - smart.ambulanceDelayTotal).toFixed(1)+'s');
  set('impact-co2', Math.max(0, dumb.co2 - smart.co2).toFixed(0)+'g');

  ['N','S','E','W'].forEach(d => {
    const cnt = smart.cars[d][0].length + smart.cars[d][1].length;
    const pct = Math.min(100, (cnt/W.MAX_CARS)*100);
    const el2 = document.getElementById(`density-${d.toLowerCase()}`);
    const pe  = document.getElementById(`density-${d.toLowerCase()}-pct`);
    if (el2) el2.style.width = pct+'%';
    if (pe)  pe.textContent = Math.round(pct)+'%';
  });

  const lp = document.getElementById('live-state-display');
  if (lp) {
    lp.classList.remove('hidden');
    const ps = document.getElementById('live-phase-text')?.querySelector('span');
    const rs = document.querySelector('#live-reason-text .reason-highlight');
    const am = state.activeMode === 'smart' ? smart : dumb;
    if (state.pedestrianActive) {
      if (ps) ps.textContent = 'ALL RED — PEDESTRIAN CROSSING';
      if (rs) rs.textContent = 'Pedestrian phase active';
      document.getElementById('ui-light-red')?.classList.add('active');
      document.getElementById('ui-light-yellow')?.classList.remove('active');
      document.getElementById('ui-light-green')?.classList.remove('active');
    } else {
      if (ps) ps.textContent = am.phase === 'NS' ? 'NORTH-SOUTH GREEN' : 'EAST-WEST GREEN';
      if (rs) rs.textContent = state.activeMode === 'smart' ? logic.liveReason : 'Fixed 30s timer cycle';
      document.getElementById('ui-light-red')?.classList.remove('active');
      document.getElementById('ui-light-yellow')?.classList.toggle('active', am.isYellow);
      document.getElementById('ui-light-green')?.classList.toggle('active', !am.isYellow);
    }
  }

  const sr = document.getElementById('smart-active-rule');
  if (sr) sr.textContent = logic.liveReason;
  if (state.activeMode === 'smart') updateLogicPanel();
}

function updateLogicPanel() {
  const s = logic.sensors;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const tgl = (id, v) => {
    const e = document.getElementById(id);
    if (!e) return;
    e.classList.toggle('active', v===1);
    const vn = e.querySelector('.sensor-val'); if (vn) vn.textContent = v;
  };
  tgl('sensor-dn',s.D_N); tgl('sensor-ds',s.D_S); tgl('sensor-de',s.D_E); tgl('sensor-dw',s.D_W);
  tgl('sensor-an',s.A_N); tgl('sensor-as',s.A_S); tgl('sensor-ae',s.A_E); tgl('sensor-aw',s.A_W);
  tgl('sensor-p',s.P); tgl('sensor-t',s.T);
  set('ff-s',logic.flipFlop.S); set('ff-r',logic.flipFlop.R); set('ff-q',logic.flipFlop.Q);
  set('ff-q-display', logic.flipFlop.Q===0?'NS':'EW');
  set('bool-expression', logic.boolExpr);
  const ctx = document.getElementById('circuit-canvas')?.getContext('2d');
  if (ctx) drawCircuit(ctx);
}

function drawCircuit(ctx) {
  const cw=280, ch=320;
  ctx.clearRect(0,0,cw,ch);
  ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fillRect(0,0,cw,ch);
  const s=logic.sensors, ac='#00ff88', ic='#2a2a4a';
  const inputs=[
    {label:'A_NS',val:s.A_N||s.A_S,x:10,y:40},{label:'A_EW',val:s.A_E||s.A_W,x:10,y:70},
    {label:'D_NS',val:s.D_N||s.D_S,x:10,y:130},{label:'D_EW',val:s.D_E||s.D_W,x:10,y:160},
    {label:'P',val:s.P,x:10,y:220},{label:'T',val:s.T,x:10,y:250},
  ];
  inputs.forEach(inp=>{
    ctx.fillStyle=inp.val?ac:ic; ctx.beginPath(); ctx.arc(22,inp.y,7,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ccc'; ctx.font='9px monospace'; ctx.textAlign='left';
    ctx.fillText(inp.label,34,inp.y+4);
    ctx.strokeStyle=inp.val?'#00ff8866':'#1a1a3a'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(41,inp.y); ctx.lineTo(85,inp.y); ctx.stroke();
  });
  ctx.fillStyle='rgba(0,212,170,0.08)'; ctx.fillRect(85,30,60,80);
  ctx.strokeStyle='#00d4aa'; ctx.lineWidth=2; ctx.strokeRect(85,30,60,80);
  ctx.fillStyle='#00d4aa'; ctx.font='bold 8px monospace'; ctx.textAlign='center';
  ctx.fillText('PRIORITY',115,60); ctx.fillText('ENCODER',115,72);
  ctx.fillStyle='rgba(0,212,170,0.08)'; ctx.fillRect(85,160,60,60);
  ctx.strokeStyle='#00d4aa'; ctx.lineWidth=2; ctx.strokeRect(85,160,60,60);
  ctx.fillStyle='#00d4aa'; ctx.font='bold 8px monospace'; ctx.textAlign='center';
  ctx.fillText('SR',115,182); ctx.fillText('FLIP-FLOP',115,194);
  ctx.font='bold 9px monospace'; ctx.textAlign='left';
  ctx.fillStyle=logic.flipFlop.S?ac:'#556'; ctx.fillText(`S=${logic.flipFlop.S}`,88,210);
  ctx.fillStyle=logic.flipFlop.R?ac:'#556'; ctx.fillText(`R=${logic.flipFlop.R}`,88,222);
  ctx.textAlign='right'; ctx.fillStyle=ac; ctx.font='bold 11px monospace';
  ctx.fillText(`Q=${logic.flipFlop.Q}`,142,215);
  ctx.strokeStyle=ac; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(145,110); ctx.lineTo(185,110); ctx.stroke();
  ctx.fillStyle=smart.phase==='NS'?'#3b82f6':'#8b5cf6';
  ctx.font='bold 12px monospace'; ctx.textAlign='left';
  ctx.fillText(`→ ${smart.phase}`,165,75);
  ctx.fillStyle=ac; ctx.font='bold 10px monospace';
  ctx.fillText(`GREEN: ${smart.phase==='NS'?'N/S':'E/W'}`,90,260);
  ctx.fillStyle='#ff3355';
  ctx.fillText(`RED: ${smart.phase==='NS'?'E/W':'N/S'}`,90,278);
}

// ============================================================
// SPAWNER
// ============================================================
let _lastSpawn = 0;

function spawnCars(now) {
  const interval = Math.max(80, W.SPAWN_INTERVAL / (state.density * state.simSpeed));
  if (now - _lastSpawn < interval) return;
  _lastSpawn = now;

  ['N','S','E','W'].forEach(dir => {
    const total = dumb.cars[dir][0].length + dumb.cars[dir][1].length;
    if (total >= W.MAX_CARS) return;

    // Prefer distributing across both lanes
    const sl0 = dumb.cars[dir][0].length;
    const sl1 = dumb.cars[dir][1].length;
    // Choose the less populated sub-lane, but with randomness
    let sl = (sl0 <= sl1) ? 0 : 1;
    if (Math.random() < 0.3) sl = 1 - sl; // occasionally pick the other lane

    const lane = getLaneDef(dir, sl);
    const spawnPos = lane.start;

    // Check spawn clearance
    const occupied = dumb.cars[dir][sl].some(c => Math.abs(c.pos - spawnPos) < W.CAR_L * 3.5);
    if (occupied) return;

    const chance = (dir==='N'||dir==='S') && state.density>=7 ? 0.7 : 0.38;
    if (Math.random() > chance) return;

    const type = Math.random() < 0.05 ? 'bus' : 'car';
    const carD = createCar(dir, sl, type);
    const carS = createCar(dir, sl, type);
    carS.color = carD.color; // sync appearance

    dumb.cars[dir][sl].push(carD);
    smart.cars[dir][sl].push(carS);
  });
}

function spawnAmbulance() {
  const dirs = ['N','S','E','W'];
  const dir = dirs[Math.floor(Math.random()*4)];
  const sl  = Math.floor(Math.random()*2);

  const make = () => createCar(dir, sl, 'ambulance');
  const aD = make(), aS = make();
  aS.color = aD.color;

  dumb.cars[dir][sl].unshift(aD);
  smart.cars[dir][sl].unshift(aS);

  const banner = document.getElementById('emergency-banner');
  const text   = document.getElementById('emergency-text');
  if (banner && text) {
    text.textContent = `EMERGENCY VEHICLE — ${({N:'NORTH',S:'SOUTH',E:'EAST',W:'WEST'})[dir]}`;
    banner.classList.remove('hidden');
    clearTimeout(state.emergencyTimeout);
    state.emergencyTimeout = setTimeout(() => banner.classList.add('hidden'), 5000);
  }
}

function activatePedestrian() {
  state.pedestrianActive = true;
  state.pedestrianTimer  = 12; // Slightly longer for clarity

  const banner = document.getElementById('pedestrian-banner');
  if (banner) {
    banner.classList.remove('hidden');
    // Hide emergency banner if active to avoid clutter
    document.getElementById('emergency-banner')?.classList.add('hidden');
  }
}

// ============================================================
// MAIN LOOP
// ============================================================
let _lastTime = performance.now();
let _lastLogic = 0;
let _uiAcc     = 0;

function gameLoop(now) {
  requestAnimationFrame(gameLoop);
  if (!state.running) return;

  const dt = Math.min(now - _lastTime, 48);
  _lastTime = now;

  spawnCars(now);
  updateDumbController(dt);

  // Smart phase timer
  const el = (dt/1000) * state.simSpeed;
  if (smart.isYellow) {
    smart.yellowTimer -= el;
    if (smart.yellowTimer <= 0) {
      smart.isYellow = false;
      smart.phase = smart.nextPhase || (smart.phase==='NS'?'EW':'NS');
      smart.phaseTimer = logic.greenTime || W.SMART_MIN;
      setLights(smart);
    }
  } else {
    smart.phaseTimer -= el;
  }

  if (now - _lastLogic > W.LOGIC_TICK) { updateSmartController(); _lastLogic = now; }

  if (state.pedestrianActive) {
    state.pedestrianTimer -= el;
    if (state.pedestrianTimer <= 0) {
      state.pedestrianActive = false;
      document.getElementById('pedestrian-banner')?.classList.add('hidden');
    }
  }

  updateCars(dumb, dt);
  updateCars(smart, dt);

  if (state.activeMode === 'dumb')  renderFrame(dumbThree, dumb);
  if (state.activeMode === 'smart') renderFrame(smartThree, smart);

  _uiAcc += dt;
  if (_uiAcc > 35) { updateUI(); _uiAcc = 0; }
}

// ============================================================
// SPA ROUTING & CONTROLS
// ============================================================
function switchSPA(mode) {
  state.activeMode = mode;
  document.body.className = `mode-${mode}`;
  document.getElementById('nav-dumb')?.classList.toggle('active', mode==='dumb');
  document.getElementById('nav-smart')?.classList.toggle('active', mode==='smart');
  document.getElementById('nav-about')?.classList.toggle('active', mode==='about');
  
  document.getElementById('page-dumb')?.classList.toggle('active', mode==='dumb');
  document.getElementById('page-smart')?.classList.toggle('active', mode==='smart');
  document.getElementById('page-about')?.classList.toggle('active', mode==='about');
}

function initControls() {
  document.getElementById('nav-dumb')?.addEventListener('click', () => switchSPA('dumb'));
  document.getElementById('nav-smart')?.addEventListener('click', () => switchSPA('smart'));
  document.getElementById('nav-about')?.addEventListener('click', () => switchSPA('about'));

  const pb = document.getElementById('btn-pause');
  if (pb) pb.addEventListener('click', () => {
    state.running = !state.running;
    pb.textContent = state.running ? '⏸ Pause' : '▶ Resume';
    pb.style.background = state.running ? '' : '#ffcc00';
    pb.style.color = state.running ? '' : '#000';
  });

  document.getElementById('density-slider')?.addEventListener('input', e => {
    state.density = parseInt(e.target.value);
    const dv = document.getElementById('density-value'); if (dv) dv.textContent = state.density;
  });

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.simSpeed = parseInt(btn.dataset.speed);
    });
  });

  document.getElementById('spawn-ambulance')?.addEventListener('click', spawnAmbulance);
  document.getElementById('pedestrian-btn')?.addEventListener('click', activatePedestrian);

  document.getElementById('reset-btn')?.addEventListener('click', () => {
    dumb  = createModeState();
    smart = createModeState();
    logic.flipFlop = {S:0,R:0,Q:0};
    logic.sensors  = {D_N:0,D_S:0,D_E:0,D_W:0,A_N:0,A_S:0,A_E:0,A_W:0,P:0,T:0};
    state.startTime = Date.now();
    state.pedestrianActive = false;
    document.getElementById('emergency-banner')?.classList.add('hidden');
  });
}

// ============================================================
// INIT
// ============================================================
function init() {
  initControls();
  dumbThree  = initThreeJS('dumb-canvas');
  smartThree = initThreeJS('smart-canvas');
  const cc = document.getElementById('circuit-canvas');
  if (cc) {
    const dpr = window.devicePixelRatio||1;
    cc.width = 280*dpr; cc.height = 320*dpr;
    cc.getContext('2d').scale(dpr, dpr);
  }
  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);
