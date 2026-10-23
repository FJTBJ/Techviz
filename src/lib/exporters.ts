import { ASPECTS, SENSORS, type ShotCamera } from '../types';
import { lensMath } from './lens';

export function downloadBlob(filename: string, content: string | Blob, mime = 'text/plain;charset=utf-8') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 将画布按目标画幅裁切，并在上下加上参数信息条，输出机位图 */
export function composeShotImage(
  canvas: HTMLCanvasElement,
  shot: ShotCamera,
  projectName: string,
): string {
  const aspect = ASPECTS[shot.aspect];
  const srcW = canvas.width;
  const srcH = canvas.height;
  let cropW = srcW;
  let cropH = srcH;
  if (srcW / srcH >= aspect) {
    cropH = srcH;
    cropW = srcH * aspect;
  } else {
    cropW = srcW;
    cropH = srcW / aspect;
  }
  const srcX = (srcW - cropW) / 2;
  const srcY = (srcH - cropH) / 2;

  const outW = 1600;
  const imgH = Math.round(outW / aspect);
  const headerH = 108;
  const footerH = 64;

  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = imgH + headerH + footerH;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');

  ctx.fillStyle = '#0b1016';
  ctx.fillRect(0, 0, out.width, out.height);

  ctx.drawImage(canvas, srcX, srcY, cropW, cropH, 0, headerH, outW, imgH);

  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, headerH + 0.5, outW - 1, imgH - 1);

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8eef7';
  ctx.font = '600 30px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText(`${shot.sceneNo} / ${shot.shotNo}`, 32, 42);
  ctx.font = '400 20px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#8fa1b8';
  ctx.fillText(`${projectName} · Techviz 机位图`, 32, 76);

  ctx.textAlign = 'right';
  ctx.font = '600 26px ui-monospace, Consolas, monospace';
  ctx.fillStyle = '#ffb020';
  ctx.fillText(
    `${shot.focal}mm  |  ${shot.aspect}  |  机位高度 ${shot.position[1].toFixed(2)}m`,
    outW - 32,
    42,
  );
  ctx.font = '400 19px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#8fa1b8';
  ctx.fillText(
    `${SENSORS[shot.sensor].label} · 水平视角 ${lens.hfovDeg.toFixed(1)}° · ${shot.rig}`,
    outW - 32,
    78,
  );

  ctx.textAlign = 'left';
  ctx.font = '400 18px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#7d8ea5';
  const notes = shot.notes ? `备注：${shot.notes}` : '备注：—';
  ctx.fillText(notes.slice(0, 110), 32, headerH + imgH + footerH / 2);

  ctx.textAlign = 'right';
  ctx.fillText(
    `机位 ${shot.position.map((n) => n.toFixed(2)).join(' / ')} · 等效 ${lens.equivalentFocal.toFixed(0)}mm`,
    outW - 32,
    headerH + imgH + footerH / 2,
  );

  return out.toDataURL('image/png');
}

export function shotCsv(shot: ShotCamera, projectName: string): string {
  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
  const coverage = lens.coverageAt(5);
  const header = [
    '项目',
    '场次',
    '镜号',
    '机位X(m)',
    '机位高度(m)',
    '机位Z(m)',
    '水平角(°)',
    '俯仰(°)',
    '横滚(°)',
    '传感器',
    '焦距(mm)',
    '等效焦距(mm)',
    '画幅',
    '水平视角(°)',
    '垂直视角(°)',
    '器材',
    '5m处画面宽(m)',
    '5m处画面高(m)',
    '备注',
  ];
  const row = [
    projectName,
    shot.sceneNo,
    shot.shotNo,
    shot.position[0].toFixed(2),
    shot.position[1].toFixed(2),
    shot.position[2].toFixed(2),
    shot.yaw.toFixed(1),
    shot.pitch.toFixed(1),
    shot.roll.toFixed(1),
    SENSORS[shot.sensor].label,
    shot.focal.toString(),
    lens.equivalentFocal.toFixed(0),
    shot.aspect,
    lens.hfovDeg.toFixed(1),
    lens.vfovDeg.toFixed(1),
    shot.rig,
    coverage.width.toFixed(2),
    coverage.height.toFixed(2),
    shot.notes.replace(/\r?\n/g, ' '),
  ];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return '\uFEFF' + [header, row].map((r) => r.map(escape).join(',')).join('\r\n');
}
