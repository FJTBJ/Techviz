/**
 * 机位朝向计算：把每个镜头的视线摆向 LED 环屏
 *
 * 规则：
 *   - 环屏是固定对象，缺口中心始终在 three +Z（面向观众/机位一侧），不旋转
 *   - 每个镜头保留机位位置、俯仰和整条 take 的镜头运动（摇/移）
 *   - 只给整条 take 加一个固定偏航修正角 Δ，使画面尽量落在 LED 屏上
 *   - Δ 以 5° 步长搜索：LED 覆盖率最大 → 无覆盖最小 → |Δ| 最小
 *
 * 输出：server/data/shot-aim.json（计算前 / 计算后两组数据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetPlan } from '../setplan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const TIMELINE_FILE = path.join(DATA, 'previz-timeline.json');
const RING_FILE = path.join(DATA, 'ring-led01.json');
const OUT_FILE = path.join(DATA, 'shot-aim.json');

/** 主预演画幅：S35 传感器裁 2.39:1 */
const SENSOR_W = 24.89;
const SENSOR_H = 24.89 / 2.39;
const DEFAULT_FOCAL = 35;
const STEP_DEG = 5;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const round1 = (n) => Math.round(n * 10) / 10;

function main() {
  const timeline = readJson(TIMELINE_FILE);
  const ringFile = readJson(RING_FILE);
  const d = ringFile.derived;

  const ring = {
    diameter: d.diameterM,
    height: d.totalHeightM,
    arc: d.arcDeg,
    gapCenterDeg: 0, // 缺口中心在 three +Z，始终朝向观众/机位一侧
  };

  const coverage = (shot, deltaDeg) => {
    const plan = buildSetPlan({
      ring,
      shots: [
        {
          id: shot.id,
          name: shot.name,
          scene: shot.scene,
          focal: shot.focal ?? DEFAULT_FOCAL,
          sensorWidth: SENSOR_W,
          sensorHeight: SENSOR_H,
          keys: shot.keys.map((k) => ({ ...k, yaw: k.yaw + deltaDeg })),
          position: shot.keys[0].position,
          yaw: shot.keys[0].yaw + deltaDeg,
          pitch: shot.keys[0].pitch,
        },
      ],
    });
    const c = plan.shots[0].coverage;
    return { led: round1(c.led), ground: round1(c.ground), open: round1(c.open) };
  };

  const rows = [];
  for (const shot of timeline.shots ?? []) {
    if (!shot.keys?.length) continue;
    const before = coverage(shot, 0);
    let best = null;
    for (let delta = 0; delta < 360; delta += STEP_DEG) {
      const c = coverage(shot, delta);
      const candidate = { delta, coverage: c };
      if (
        !best ||
        c.led > best.coverage.led ||
        (c.led === best.coverage.led && c.open < best.coverage.open) ||
        (c.led === best.coverage.led && c.open === best.coverage.open && delta < best.delta)
      ) {
        best = candidate;
      }
    }
    rows.push({
      id: shot.id,
      name: shot.name,
      scene: shot.scene,
      start: shot.start,
      end: shot.end,
      focal: shot.focal ?? DEFAULT_FOCAL,
      before,
      deltaDeg: best.delta,
      after: best.coverage,
    });
  }

  const summarize = (pick) => {
    if (!rows.length) return { shots: 0, led: 0, ground: 0, open: 0, zeroLed: 0 };
    const acc = { shots: 0, led: 0, ground: 0, open: 0, zeroLed: 0 };
    for (const row of rows) {
      const c = pick(row);
      acc.shots += 1;
      acc.led += c.led;
      acc.ground += c.ground;
      acc.open += c.open;
      if (c.led <= 0) acc.zeroLed += 1;
    }
    return {
      shots: acc.shots,
      led: round1(acc.led / acc.shots),
      ground: round1(acc.ground / acc.shots),
      open: round1(acc.open / acc.shots),
      zeroLed: acc.zeroLed,
    };
  };

  const scenes = [...new Set(rows.map((r) => r.scene).filter(Boolean))].sort();
  const sceneSummary = {};
  for (const scene of scenes) {
    const list = rows.filter((r) => r.scene === scene);
    const avg = (pick) => round1(list.reduce((a, r) => a + pick(r), 0) / list.length);
    sceneSummary[scene] = {
      shots: list.length,
      before: {
        led: avg((r) => r.before.led),
        open: avg((r) => r.before.open),
        zeroLed: list.filter((r) => r.before.led <= 0).length,
      },
      after: {
        led: avg((r) => r.after.led),
        open: avg((r) => r.after.open),
        zeroLed: list.filter((r) => r.after.led <= 0).length,
      },
      maxDeltaDeg: Math.max(...list.map((r) => r.deltaDeg)),
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'aim-at-led',
    ring: {
      diameter: ring.diameter,
      height: ring.height,
      arc: ring.arc,
      gapCenterDeg: ring.gapCenterDeg,
    },
    frame: { sensor: 'S35', sensorWidth: SENSOR_W, sensorHeight: round1(SENSOR_H * 100) / 100, aspect: '2.39:1' },
    note:
      '环屏与缺口固定（缺口中心 +Z，面向机位一侧）；每个镜头保留机位位置、俯仰与镜头运动，' +
      '只加一个固定偏航修正角 Δ，使画面尽量落在 LED 屏上。',
    summary: {
      before: summarize((r) => r.before),
      after: summarize((r) => r.after),
    },
    scenes: sceneSummary,
    shots: rows,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  const b = out.summary.before;
  const a = out.summary.after;
  console.log(
    `[aim-shots] ${rows.length} 镜 → ${OUT_FILE}\n` +
      `  计算前：LED ${b.led}% / 无覆盖 ${b.open}% / 零覆盖 ${b.zeroLed} 镜\n` +
      `  计算后：LED ${a.led}% / 无覆盖 ${a.open}% / 零覆盖 ${a.zeroLed} 镜`,
  );
}

main();
