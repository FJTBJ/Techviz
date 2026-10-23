/**
 * 批量提取预演 take 序列中的相机动画
 *
 * 数据源：server/data/previz-shots.json（由 UE 分析缓存整理的 60 个镜头 → 31 个唯一 take）
 * 解析器：server/previz/uecam.mjs（离线读取 .uasset，只读）
 * 输出：server/data/previz-cameras.json
 *
 * 坐标：UE 厘米/度 → three.js 米/度
 *   three = [ueY/100, ueZ/100, -ueX/100]
 *   yaw_three = -yaw_ue（UE yaw 从 +X 向 +Y，three 中 +X_ue 对应 -Z）
 *   pitch_three = pitch_ue（正值为抬头）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS_FILE = path.join(ROOT, 'data', 'previz-shots.json');
const OUT_FILE = path.join(ROOT, 'data', 'previz-cameras.json');
const PARSER = path.join(__dirname, 'uecam.mjs');

/** 无焦距轨道时的兜底（CineCamera 常用 35mm） */
const DEFAULT_FOCAL = 35;

const deg2rad = Math.PI / 180;

function parseTake(asset) {
  const raw = execFileSync(process.execPath, [PARSER, asset], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw);
  const tick = parsed.meta?.tickResolution;
  const ticksPerSecond = tick?.numerator && tick?.denominator ? tick.numerator / tick.denominator : 24;
  const hasFocal = parsed.checks?.focalRange != null;

  const keys = parsed.keys
    .filter((k) => k.loc?.every((v) => v != null) && k.rot?.every((v) => v != null))
    .map((k) => {
      const [x, y, z] = k.loc;
      const [, pitch, yaw] = k.rot;
      return {
        t: +(k.time / ticksPerSecond).toFixed(4),
        position: [+(y / 100).toFixed(4), +(z / 100).toFixed(4), +(-x / 100).toFixed(4)],
        yaw: +((-yaw + 540) % 360 - 180).toFixed(3),
        pitch: +pitch.toFixed(3),
        focal: hasFocal && k.focal ? +k.focal.toFixed(2) : null,
      };
    });

  return {
    asset,
    durationSec: +(parsed.meta?.durationSeconds ?? 0).toFixed(3),
    firstTick: parsed.meta?.firstTick ?? null,
    fps: ticksPerSecond,
    hasFocalTrack: hasFocal,
    keyCount: keys.length,
    keys,
  };
}

function main() {
  if (!fs.existsSync(SHOTS_FILE)) {
    throw new Error(`缺少 ${SHOTS_FILE}`);
  }
  const shotsFile = JSON.parse(fs.readFileSync(SHOTS_FILE, 'utf8'));
  const takes = shotsFile.takes ?? shotsFile.shots.filter((s) => s.asset);
  const unique = new Map();
  for (const shot of takes) {
    if (shot.sequence && !unique.has(shot.sequence)) unique.set(shot.sequence, shot.asset);
  }

  const cameras = {};
  const failed = [];
  for (const [sequence, asset] of unique) {
    if (!fs.existsSync(asset)) {
      failed.push({ sequence, reason: 'asset missing' });
      continue;
    }
    try {
      cameras[sequence] = parseTake(asset);
    } catch (err) {
      failed.push({ sequence, reason: String(err).split('\n')[0] });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: SHOTS_FILE,
    parser: 'server/previz/uecam.mjs',
    defaultFocal: DEFAULT_FOCAL,
    takeCount: Object.keys(cameras).length,
    failed,
    cameras,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  console.log(
    `[extract-cameras] ${Object.keys(cameras).length}/${unique.size} takes → ${OUT_FILE}` +
      (failed.length ? `, failed: ${failed.length}` : ''),
  );
}

main();
