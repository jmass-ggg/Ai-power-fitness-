/**
 * exerciseLogic.js
 * Browser port of ai_model/exercise_logic.py — exact thresholds from Python model.
 *
 * Key fixes vs previous version:
 * 1. Thresholds match config.py exactly (squat 105/160, pushup 95/155)
 * 2. Rep cooldown raised to 800 ms to prevent micro-movement double-counting
 * 3. Squat uses avg not min — avoids phantom reps from partial landmark detection
 * 4. Push-up requires committed depth: must reach DOWN threshold, not just cross it
 * 5. Sit-up prone gate relaxed to 0.35 to allow real reps to register
 * 6. All state machines require full range of motion: must go all the way DOWN
 *    before UP counts as a rep (strict hysteresis)
 * 7. MIN_VISIBILITY raised to 0.3 for more reliable landmark filtering
 */

// ─── LANDMARK INDICES ────────────────────────────────────────────────────────
export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,     RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,     RIGHT_WRIST: 16,
  LEFT_HIP: 23,       RIGHT_HIP: 24,
  LEFT_KNEE: 25,      RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,     RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,      RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

export const POSE_CONNECTIONS = [
  [LM.LEFT_SHOULDER,  LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER,  LM.LEFT_ELBOW],
  [LM.LEFT_ELBOW,     LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  [LM.RIGHT_ELBOW,    LM.RIGHT_WRIST],
  [LM.LEFT_SHOULDER,  LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP,       LM.RIGHT_HIP],
  [LM.LEFT_HIP,       LM.LEFT_KNEE],
  [LM.LEFT_KNEE,      LM.LEFT_ANKLE],
  [LM.LEFT_ANKLE,     LM.LEFT_HEEL],
  [LM.LEFT_HEEL,      LM.LEFT_FOOT_INDEX],
  [LM.RIGHT_HIP,      LM.RIGHT_KNEE],
  [LM.RIGHT_KNEE,     LM.RIGHT_ANKLE],
  [LM.RIGHT_ANKLE,    LM.RIGHT_HEEL],
  [LM.RIGHT_HEEL,     LM.RIGHT_FOOT_INDEX],
];

// ─── CONFIG — exact values from ai_model/config.py ───────────────────────────
const MIN_VISIBILITY = 0.3;   // raised from 0.05 — filters shaky/partial landmarks

// Exact thresholds from config.py
const SQUAT_DOWN_KNEE_ANGLE   = 105;
const SQUAT_UP_KNEE_ANGLE     = 160;
const PUSHUP_DOWN_ELBOW_ANGLE = 95;
const PUSHUP_UP_ELBOW_ANGLE   = 155;
const JACK_OPEN_FOOT_MULT     = 1.25;
const JACK_CLOSED_FOOT_MULT   = 1.00;
const PLANK_GOOD_BODY_ANGLE   = 160;
const LUNGE_DOWN_KNEE_ANGLE   = 115;
const LUNGE_UP_KNEE_ANGLE     = 155;

// Rep counting — must stay in DOWN long enough, and cooldown prevents double-fire
const REP_COOLDOWN_MS     = 800;   // was 350 — now prevents micro-movement counting
const MIN_DOWN_HOLD_MS    = 200;   // must hold DOWN position for at least this long

// ─── CALORIE CONSTANTS ───────────────────────────────────────────────────────
export const CALORIES_PER_REP = {
  "Squat":            0.32,
  "Push-up":          0.29,
  "Jumping Jack":     0.20,
  "Lunge":            0.30,
  "Sit-up":           0.25,
  "Burpee":           0.50,
  "Mountain Climber": 0.18,
};
export const PLANK_CALORIES_PER_SECOND = 0.06;

// ─── POSE HELPERS ─────────────────────────────────────────────────────────────

export function calculateAngle(a, b, c) {
  const radians =
    Math.atan2(c[1] - b[1], c[0] - b[0]) -
    Math.atan2(a[1] - b[1], a[0] - b[0]);
  let angle = Math.abs((radians * 180.0) / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

function lmXY(landmarks, idx) {
  const lm = landmarks[idx];
  return [lm.x, lm.y];
}

function lmVisible(landmarks, idx) {
  const lm = landmarks[idx];
  if (!lm) return false;
  if (lm.x < -0.2 || lm.x > 1.2) return false;
  if (lm.y < -0.2 || lm.y > 1.2) return false;
  const vis = lm.visibility ?? 1.0;
  const pre = lm.presence  ?? 1.0;
  return vis >= MIN_VISIBILITY && pre >= MIN_VISIBILITY;
}

function allVisible(landmarks, indices) {
  return indices.every((i) => lmVisible(landmarks, i));
}

const SIDE_MAP = {
  left:  { shoulder: LM.LEFT_SHOULDER,  elbow: LM.LEFT_ELBOW,  wrist: LM.LEFT_WRIST,  hip: LM.LEFT_HIP,  knee: LM.LEFT_KNEE,  ankle: LM.LEFT_ANKLE  },
  right: { shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST, hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE },
};

function sideVisible(landmarks, side, parts) {
  const map = SIDE_MAP[side];
  return allVisible(landmarks, parts.map((p) => map[p]));
}

function getSidePoints(landmarks, side) {
  const map = SIDE_MAP[side];
  const result = {};
  for (const [part, idx] of Object.entries(map)) {
    result[part] = lmXY(landmarks, idx);
  }
  return result;
}

function avg(arr) {
  const clean = arr.filter((v) => v != null);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function noLandmarks(state, msg) {
  state.feedback  = msg;
  state.formScore = 0;
  if (state.exercise === "Plank") {
    state.plankStartTime = null;
    state.plankSeconds   = 0;
    state.plankCountdownStartTime = null;
    state.plankCountdownDone      = false;
  }
  return { metrics: {}, state };
}

/**
 * Count a rep only if:
 * 1. cooldown has passed since last rep
 * 2. user actually held the DOWN position for MIN_DOWN_HOLD_MS
 */
function countRep(state, nowMs) {
  const cooldownOk = nowMs - (state.lastRepTime || 0) >= REP_COOLDOWN_MS;
  const holdOk     = state.downEnteredAt
    ? nowMs - state.downEnteredAt >= MIN_DOWN_HOLD_MS
    : false;

  if (cooldownOk && holdOk) {
    state.reps       += 1;
    state.lastRepTime = nowMs;
    state.downEnteredAt = null;
    return true;
  }
  return false;
}

// ─── STATE FACTORY ────────────────────────────────────────────────────────────

export function createState(exercise) {
  return {
    exercise,
    position:    "UNKNOWN",
    reps:        0,
    bestDepthAngle: 999,
    downEnteredAt:  null,   // timestamp when DOWN was entered (for hold check)
    lastRepTime:    0,
    // Plank
    plankStartTime:         null,
    plankSeconds:           0,
    bestPlankSeconds:       0,
    plankCountdownStartTime: null,
    plankCountdownDone:     false,
    plankFormBad:           false,
    plankLastAlarmMs:       0,
    // General
    feedback:  "Stand where your full body is visible.",
    formScore: 100,
  };
}

// ─── SQUAT ───────────────────────────────────────────────────────────────────
// Thresholds: DOWN ≤ 105°, UP ≥ 160° (from config.py)
// Uses AVERAGE of both sides (not min) — same as Python model
// Rep counted: DOWN → UP transition, with hold check

function analyzeSquat(landmarks, state, nowMs) {
  const kneeAngles = [], hipAngles = [];

  for (const side of ["left", "right"]) {
    if (sideVisible(landmarks, side, ["shoulder", "hip", "knee", "ankle"])) {
      const p = getSidePoints(landmarks, side);
      kneeAngles.push(calculateAngle(p.hip,      p.knee, p.ankle));
      hipAngles.push( calculateAngle(p.shoulder, p.hip,  p.knee));
    }
  }

  const kneeAngle = avg(kneeAngles);
  const hipAngle  = avg(hipAngles);

  if (kneeAngle == null) {
    return noLandmarks(state, "Move back — hips, knees and ankles must all be visible.");
  }

  if (kneeAngle < state.bestDepthAngle) state.bestDepthAngle = kneeAngle;

  // State machine with strict thresholds from config.py
  if (kneeAngle <= SQUAT_DOWN_KNEE_ANGLE) {
    if (state.position !== "DOWN") {
      state.position    = "DOWN";
      state.downEnteredAt = nowMs;
    }
  } else if (kneeAngle >= SQUAT_UP_KNEE_ANGLE) {
    if (state.position === "DOWN") {
      countRep(state, nowMs);
      state.bestDepthAngle = 999;
    }
    state.position = "UP";
  }
  // angles between 105–160 are mid-movement — keep current label

  let score = 100;
  const feedbacks = [];

  if      (state.position === "UNKNOWN") feedbacks.push("Stand tall, then squat deep.");
  else if (state.position === "UP")      feedbacks.push("Standing. Now squat below 90°.");
  else if (state.position === "DOWN")    feedbacks.push("Good depth! Drive back up.");

  if (state.position !== "DOWN" && kneeAngle < SQUAT_UP_KNEE_ANGLE && kneeAngle > SQUAT_DOWN_KNEE_ANGLE) {
    feedbacks.push("Keep going — squat deeper.");
    score -= 10;
  }
  if (hipAngle != null && hipAngle < 55) { feedbacks.push("Keep chest up."); score -= 20; }
  if (!feedbacks.length) feedbacks.push("Move with control.");

  state.feedback  = feedbacks.join(" ");
  state.formScore = Math.max(0, Math.min(100, score));
  return { metrics: { "Knee angle": kneeAngle, "Hip angle": hipAngle }, state };
}

// ─── PUSH-UP ──────────────────────────────────────────────────────────────────
// Thresholds: DOWN ≤ 95°, UP ≥ 155° (exact from config.py)
// Prone gate: y-diff < 0.35 AND body angle > 140°
// Rep counted: DOWN → UP, with committed hold at DOWN

const PUSHUP_MIN_BODY_ANGLE = 140;
const PUSHUP_PRONE_Y_DIFF   = 0.35;

function analyzePushup(landmarks, state, nowMs) {
  const elbowAngles = [], bodyAngles = [];
  const shoulderYs  = [], ankleYs   = [];

  for (const side of ["left", "right"]) {
    if (sideVisible(landmarks, side, ["shoulder", "elbow", "wrist", "hip", "ankle"])) {
      const p = getSidePoints(landmarks, side);
      elbowAngles.push(calculateAngle(p.shoulder, p.elbow, p.wrist));
      bodyAngles.push( calculateAngle(p.shoulder, p.hip,   p.ankle));
      shoulderYs.push(p.shoulder[1]);
      ankleYs.push(   p.ankle[1]);
    }
  }

  const elbowAngle = avg(elbowAngles);
  const bodyAngle  = avg(bodyAngles);
  const shoulderY  = avg(shoulderYs);
  const ankleY     = avg(ankleYs);

  if (elbowAngle == null) {
    return noLandmarks(state, "Side view needed — shoulder, elbow, wrist, hip and ankle must be visible.");
  }

  // Prone gate: blocks counting while standing, sitting, or bending
  const yDiff   = Math.abs((ankleY ?? 1) - (shoulderY ?? 0));
  const isProne = yDiff < PUSHUP_PRONE_Y_DIFF && (bodyAngle == null || bodyAngle > PUSHUP_MIN_BODY_ANGLE);

  if (!isProne) {
    state.position    = "UNKNOWN";
    state.downEnteredAt = null;
    state.feedback    = "Get into push-up position — body flat, face down.";
    state.formScore   = 0;
    return { metrics: { "Elbow angle": elbowAngle, "Body angle": bodyAngle }, state };
  }

  // Strict thresholds: DOWN ≤ 95, UP ≥ 155
  if (elbowAngle <= PUSHUP_DOWN_ELBOW_ANGLE) {
    if (state.position !== "DOWN") {
      state.position    = "DOWN";
      state.downEnteredAt = nowMs;
    }
  } else if (elbowAngle >= PUSHUP_UP_ELBOW_ANGLE) {
    if (state.position === "DOWN") {
      countRep(state, nowMs);
    }
    state.position = "UP";
  }
  // 95–155 is mid-movement — keep label

  let score = 100;
  const feedbacks = [];

  if      (state.position === "UNKNOWN") feedbacks.push("Start in high plank, then lower chest to floor.");
  else if (state.position === "UP")      feedbacks.push("Arms extended. Lower chest to floor.");
  else if (state.position === "DOWN")    feedbacks.push("Good — chest low! Push back up fully.");

  if (bodyAngle != null && bodyAngle < 150) { feedbacks.push("Keep body straight — hips are sagging."); score -= 25; }
  if (!feedbacks.length) feedbacks.push("Full range — chest down, arms fully extended.");

  state.feedback  = feedbacks.join(" ");
  state.formScore = Math.max(0, Math.min(100, score));
  return { metrics: { "Elbow angle": elbowAngle, "Body angle": bodyAngle }, state };
}

// ─── SIT-UP ───────────────────────────────────────────────────────────────────
// Gate 1: knee angle < 130° (knees bent)
// Gate 2: |shoulder.y - hip.y| < 0.35 (lying flat — relaxed from 0.20)
// DOWN (flat):   torso angle 90°–140°
// UP   (curled): torso angle < 55°
// Rep: DOWN → UP → DOWN cycle

const SITUP_DOWN_MIN    = 90;
const SITUP_DOWN_MAX    = 140;
const SITUP_UP_MAX      = 55;
const SITUP_KNEE_MAX    = 130;
const SITUP_PRONE_YDIFF = 0.35;  // relaxed from 0.20 to allow real reps

function analyzeSitup(landmarks, state, nowMs) {
  const torsoAngles = [], kneeAngles = [];
  const shoulderYs  = [], hipYs     = [];

  for (const side of ["left", "right"]) {
    if (sideVisible(landmarks, side, ["shoulder", "hip", "knee"])) {
      const p = getSidePoints(landmarks, side);
      torsoAngles.push(calculateAngle(p.shoulder, p.hip, p.knee));
      shoulderYs.push(p.shoulder[1]);
      hipYs.push(p.hip[1]);
    }
    if (sideVisible(landmarks, side, ["hip", "knee", "ankle"])) {
      const p = getSidePoints(landmarks, side);
      kneeAngles.push(calculateAngle(p.hip, p.knee, p.ankle));
    }
  }

  const torsoAngle = avg(torsoAngles);
  const kneeAngle  = avg(kneeAngles);
  const shoulderY  = avg(shoulderYs);
  const hipY       = avg(hipYs);

  if (torsoAngle == null) {
    return noLandmarks(state, "Lie on back, side to camera — shoulder, hip and knee must be visible.");
  }

  // Gate 1: knees must be bent
  if (kneeAngle != null && kneeAngle > SITUP_KNEE_MAX) {
    state.position  = "UNKNOWN";
    state.feedback  = "Bend your knees with feet flat, then lie on your back.";
    state.formScore = 0;
    return { metrics: { "Torso angle": torsoAngle, "Knee angle": kneeAngle }, state };
  }

  // Gate 2: must be lying flat
  const yDiff = (shoulderY != null && hipY != null) ? Math.abs(shoulderY - hipY) : null;
  if (yDiff != null && yDiff > SITUP_PRONE_YDIFF) {
    state.position  = "UNKNOWN";
    state.feedback  = "Lie flat on your back to do sit-ups.";
    state.formScore = 0;
    return { metrics: { "Torso angle": torsoAngle, "Knee angle": kneeAngle }, state };
  }

  // State machine: DOWN (flat) → UP (curled) → DOWN = 1 rep
  if (torsoAngle >= SITUP_DOWN_MIN && torsoAngle <= SITUP_DOWN_MAX) {
    if (state.position === "UP") {
      // Returning to flat = rep complete
      state.reps       += 1;
      state.lastRepTime = nowMs;
    }
    if (state.position !== "DOWN") state.downEnteredAt = nowMs;
    state.position = "DOWN";
  } else if (torsoAngle < SITUP_UP_MAX) {
    state.position = "UP";
  }
  // mid-range: keep current label

  const feedbacks = [];
  if      (state.position === "UNKNOWN") feedbacks.push("Lie flat, knees bent — then curl up.");
  else if (state.position === "DOWN")    feedbacks.push("Flat. Curl torso up to your knees.");
  else if (state.position === "UP")      feedbacks.push("Good crunch! Lower back down slowly.");

  state.feedback  = feedbacks.join(" ");
  state.formScore = 100;
  return { metrics: { "Torso angle": torsoAngle, "Knee angle": kneeAngle }, state };
}

// ─── JUMPING JACK ─────────────────────────────────────────────────────────────

function analyzeJumpingJack(landmarks, state, nowMs) {
  const required = [
    LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
    LM.LEFT_WRIST,    LM.RIGHT_WRIST,
    LM.LEFT_ANKLE,    LM.RIGHT_ANKLE,
  ];

  if (!allVisible(landmarks, required)) {
    return noLandmarks(state, "Move back — wrists, shoulders and ankles must be visible.");
  }

  const ls = lmXY(landmarks, LM.LEFT_SHOULDER);
  const rs = lmXY(landmarks, LM.RIGHT_SHOULDER);
  const lw = lmXY(landmarks, LM.LEFT_WRIST);
  const rw = lmXY(landmarks, LM.RIGHT_WRIST);
  const la = lmXY(landmarks, LM.LEFT_ANKLE);
  const ra = lmXY(landmarks, LM.RIGHT_ANKLE);

  const shoulderWidth = Math.max(Math.abs(rs[0] - ls[0]), 0.01);
  const footRatio     = Math.abs(ra[0] - la[0]) / shoulderWidth;
  const avgWristY     = (lw[1] + rw[1]) / 2;
  const avgShoulderY  = (ls[1] + rs[1]) / 2;

  const wristsAbove = avgWristY < avgShoulderY;
  const wristsBelow = avgWristY > avgShoulderY + 0.10;
  const isOpen      = wristsAbove && footRatio > JACK_OPEN_FOOT_MULT;
  const isClosed    = wristsBelow && footRatio < JACK_CLOSED_FOOT_MULT;

  if (isOpen) {
    if (state.position === "CLOSED") countRep(state, nowMs);
    state.position = "OPEN";
  } else if (isClosed) {
    state.position = "CLOSED";
  }

  let score = 100;
  const feedbacks = [];
  if      (state.position === "UNKNOWN") feedbacks.push("Start closed, then jump open.");
  else if (state.position === "CLOSED")  feedbacks.push("Closed — jump open with arms overhead.");
  else if (state.position === "OPEN")    feedbacks.push("Open — return to closed.");

  if (!wristsAbove && state.position === "OPEN")                        { feedbacks.push("Raise arms overhead.");  score -= 20; }
  if (footRatio < JACK_OPEN_FOOT_MULT && state.position === "OPEN")     { feedbacks.push("Jump feet wider.");      score -= 20; }

  state.feedback  = feedbacks.join(" ");
  state.formScore = Math.max(0, Math.min(100, score));
  return { metrics: { "Foot ratio": footRatio, "Wrist height": avgShoulderY - avgWristY }, state };
}

// ─── PLANK ────────────────────────────────────────────────────────────────────

const PLANK_COUNTDOWN_SECS = 3;
const PLANK_ALARM_COOLDOWN = 2000;

function analyzePlank(landmarks, state, nowMs) {
  const bodyAngles = [];

  for (const side of ["left", "right"]) {
    if (sideVisible(landmarks, side, ["shoulder", "hip", "ankle"])) {
      const p = getSidePoints(landmarks, side);
      bodyAngles.push(calculateAngle(p.shoulder, p.hip, p.ankle));
    }
  }

  const bodyAngle = avg(bodyAngles);
  if (bodyAngle == null) {
    return noLandmarks(state, "Side view needed — shoulder, hip and ankle must be visible.");
  }

  const goodForm = bodyAngle >= PLANK_GOOD_BODY_ANGLE;
  let score = 100;
  const feedbacks = [];

  if (goodForm) {
    state.plankFormBad = false;

    if (!state.plankCountdownDone) {
      if (state.plankCountdownStartTime == null) state.plankCountdownStartTime = nowMs;
      const elapsed   = (nowMs - state.plankCountdownStartTime) / 1000;
      const remaining = Math.ceil(PLANK_COUNTDOWN_SECS - elapsed);

      if (elapsed >= PLANK_COUNTDOWN_SECS) {
        state.plankCountdownDone = true;
        state.plankStartTime     = nowMs;
        state.position           = "HOLD";
        feedbacks.push("Hold! Timer started.");
      } else {
        state.position       = "COUNTDOWN";
        state.plankCountdown = remaining;
        feedbacks.push(`Hold position… ${remaining}`);
      }
    } else {
      state.position     = "HOLD";
      state.plankSeconds = (nowMs - state.plankStartTime) / 1000;
      state.bestPlankSeconds = Math.max(state.bestPlankSeconds, state.plankSeconds);
      feedbacks.push("Perfect plank! Keep holding.");
      if (bodyAngle < 170) { feedbacks.push("Slight hip issue — keep body flat."); score -= 10; }
    }
  } else {
    state.position = "RESET";
    if (state.plankCountdownDone) {
      if (!state.plankFormBad) {
        state.plankFormBad     = true;
        state.plankLastAlarmMs = nowMs;
      } else if (nowMs - state.plankLastAlarmMs >= PLANK_ALARM_COOLDOWN) {
        state.plankLastAlarmMs = nowMs;
      }
    }
    state.plankCountdownStartTime = null;
    state.plankCountdownDone      = false;
    state.plankStartTime          = null;
    state.plankSeconds            = 0;
    state.plankCountdown          = PLANK_COUNTDOWN_SECS;

    if (bodyAngle < 140) { feedbacks.push("Hips too high or low — straighten your body."); score -= 40; }
    else                 { feedbacks.push("Almost there — straighten to start.");           score -= 20; }
  }

  state.feedback  = feedbacks.join(" ");
  state.formScore = Math.max(0, Math.min(100, score));
  return {
    metrics: { "Body angle": bodyAngle, "Hold seconds": state.plankSeconds },
    alarmNow: state.plankFormBad && (nowMs - state.plankLastAlarmMs < 100),
    state,
  };
}

// ─── LUNGE ────────────────────────────────────────────────────────────────────

function analyzeLunge(landmarks, state, nowMs) {
  let leftKnee = null, rightKnee = null;
  const torsoAngles = [];

  if (sideVisible(landmarks, "left",  ["shoulder", "hip", "knee", "ankle"])) {
    const p = getSidePoints(landmarks, "left");
    leftKnee = calculateAngle(p.hip, p.knee, p.ankle);
    torsoAngles.push(calculateAngle(p.shoulder, p.hip, p.knee));
  }
  if (sideVisible(landmarks, "right", ["shoulder", "hip", "knee", "ankle"])) {
    const p = getSidePoints(landmarks, "right");
    rightKnee = calculateAngle(p.hip, p.knee, p.ankle);
    torsoAngles.push(calculateAngle(p.shoulder, p.hip, p.knee));
  }

  const kneeAngles = [leftKnee, rightKnee].filter((v) => v != null);
  const torsoAngle = avg(torsoAngles);

  if (kneeAngles.length < 2) {
    return noLandmarks(state, "Move back — both legs must be visible for lunges.");
  }

  const frontKnee    = Math.min(...kneeAngles);
  const bothStraight = leftKnee > LUNGE_UP_KNEE_ANGLE && rightKnee > LUNGE_UP_KNEE_ANGLE;

  if (bothStraight) {
    if (state.position === "DOWN") countRep(state, nowMs);
    state.position = "UP";
  } else if (frontKnee < LUNGE_DOWN_KNEE_ANGLE) {
    if (state.position !== "DOWN") {
      state.position    = "DOWN";
      state.downEnteredAt = nowMs;
    }
  }

  let score = 100;
  const feedbacks = [];
  if      (state.position === "UNKNOWN") feedbacks.push("Step into a lunge, then stand tall.");
  else if (state.position === "UP")      feedbacks.push("Standing. Step into a deep lunge.");
  else if (state.position === "DOWN")    feedbacks.push("Good depth. Drive back to standing.");

  if (state.position === "DOWN") {
    if (frontKnee < 75)    { feedbacks.push("Don't overbend front knee."); score -= 15; }
    else if (frontKnee > 105) { feedbacks.push("Lower a little more."); score -= 15; }
  }
  if (torsoAngle != null && torsoAngle < 55) { feedbacks.push("Keep chest up."); score -= 20; }

  state.feedback  = feedbacks.join(" ");
  state.formScore = Math.max(0, Math.min(100, score));
  return { metrics: { "Front knee": frontKnee, "Left knee": leftKnee, "Right knee": rightKnee }, state };
}

// ─── BURPEE ───────────────────────────────────────────────────────────────────

function analyzeBurpee(landmarks, state, nowMs) {
  const kneeAngles = [];
  for (const side of ["left", "right"]) {
    if (sideVisible(landmarks, side, ["hip", "knee", "ankle"])) {
      const p = getSidePoints(landmarks, side);
      kneeAngles.push(calculateAngle(p.hip, p.knee, p.ankle));
    }
  }
  const kneeAngle = avg(kneeAngles);

  let wristsUp = false;
  if (allVisible(landmarks, [LM.LEFT_WRIST, LM.RIGHT_WRIST, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER])) {
    const avgWristY    = (lmXY(landmarks, LM.LEFT_WRIST)[1]    + lmXY(landmarks, LM.RIGHT_WRIST)[1])    / 2;
    const avgShoulderY = (lmXY(landmarks, LM.LEFT_SHOULDER)[1] + lmXY(landmarks, LM.RIGHT_SHOULDER)[1]) / 2;
    wristsUp = avgWristY < avgShoulderY - 0.05;
  }

  if (kneeAngle == null && !wristsUp) {
    return noLandmarks(state, "Move back — full body must be visible for burpees.");
  }

  const isDown = kneeAngle != null && kneeAngle <= 115;
  const isUp   = wristsUp && (kneeAngle == null || kneeAngle > 140);

  if (isDown) {
    if (state.position !== "DOWN") { state.position = "DOWN"; state.downEnteredAt = nowMs; }
  } else if (isUp) {
    if (state.position === "DOWN") countRep(state, nowMs);
    state.position = "UP";
  }

  const feedbacks = [];
  if      (state.position === "UNKNOWN") feedbacks.push("Stand, drop to floor, then jump up.");
  else if (state.position === "DOWN")    feedbacks.push("Floor position — push up and jump!");
  else if (state.position === "UP")      feedbacks.push("Great jump! Drop back down.");

  state.feedback  = feedbacks.join(" ");
  state.formScore = 100;
  return { metrics: { "Knee angle": kneeAngle }, state };
}

// ─── MOUNTAIN CLIMBER ────────────────────────────────────────────────────────

function analyzeMountainClimber(landmarks, state, nowMs) {
  let leftHip = null, rightHip = null;

  if (sideVisible(landmarks, "left",  ["shoulder", "hip", "knee"])) {
    const p = getSidePoints(landmarks, "left");
    leftHip = calculateAngle(p.shoulder, p.hip, p.knee);
  }
  if (sideVisible(landmarks, "right", ["shoulder", "hip", "knee"])) {
    const p = getSidePoints(landmarks, "right");
    rightHip = calculateAngle(p.shoulder, p.hip, p.knee);
  }

  if (leftHip == null && rightHip == null) {
    return noLandmarks(state, "Side view — shoulder, hip and knee must be visible.");
  }

  if (!state.mcLastDriven) state.mcLastDriven = null;
  if (!state.mcHalfReps)   state.mcHalfReps   = 0;

  const LEFT_DRIVE  = leftHip  != null && leftHip  < 80;
  const RIGHT_DRIVE = rightHip != null && rightHip < 80;

  if (LEFT_DRIVE && state.mcLastDriven !== "left") {
    state.mcLastDriven = "left";
    state.mcHalfReps  += 1;
  } else if (RIGHT_DRIVE && state.mcLastDriven !== "right") {
    state.mcLastDriven = "right";
    state.mcHalfReps  += 1;
  }

  const fullReps = Math.floor(state.mcHalfReps / 2);
  if (fullReps > state.reps) {
    state.reps       += fullReps - state.reps;
    state.lastRepTime = nowMs;
  }

  state.position = LEFT_DRIVE ? "LEFT" : RIGHT_DRIVE ? "RIGHT" : "HOLD";

  const feedbacks = [];
  if      (state.position === "HOLD")  feedbacks.push("Drive knees to chest alternately.");
  else if (state.position === "LEFT")  feedbacks.push("Left knee in — switch!");
  else if (state.position === "RIGHT") feedbacks.push("Right knee in — switch!");

  state.feedback  = feedbacks.join(" ");
  state.formScore = 100;
  return { metrics: { "Left hip": leftHip, "Right hip": rightHip }, state };
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────

export function analyzeExercise(landmarks, state, nowMs) {
  switch (state.exercise) {
    case "Squat":            return analyzeSquat(landmarks, state, nowMs);
    case "Push-up":          return analyzePushup(landmarks, state, nowMs);
    case "Sit-up":           return analyzeSitup(landmarks, state, nowMs);
    case "Jumping Jack":     return analyzeJumpingJack(landmarks, state, nowMs);
    case "Plank":            return analyzePlank(landmarks, state, nowMs);
    case "Lunge":            return analyzeLunge(landmarks, state, nowMs);
    case "Burpee":           return analyzeBurpee(landmarks, state, nowMs);
    case "Mountain Climber": return analyzeMountainClimber(landmarks, state, nowMs);
    default:
      state.feedback  = `Exercise "${state.exercise}" not supported.`;
      state.formScore = 0;
      return { metrics: {}, state };
  }
}

// ─── SLUG → DISPLAY NAME ─────────────────────────────────────────────────────

export const SLUG_TO_NAME = {
  squat:            "Squat",
  push_up:          "Push-up",
  pushup:           "Push-up",
  sit_up:           "Sit-up",
  situp:            "Sit-up",
  jumping_jack:     "Jumping Jack",
  plank:            "Plank",
  lunge:            "Lunge",
  lunges:           "Lunge",
  burpee:           "Burpee",
  burpees:          "Burpee",
  mountain_climber: "Mountain Climber",
};
