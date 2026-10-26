import type { SceneAsset, ShotCamera } from '../types';

const demo = (over: Partial<SceneAsset> & Pick<SceneAsset, 'instanceId' | 'name' | 'kind'>): SceneAsset => ({
  assetId: over.assetId ?? 'demo',
  code: over.code ?? 'DEMO',
  url: over.url,
  size: over.size ?? [1, 1, 1],
  color: over.color ?? '#6b7787',
  position: over.position ?? [0, 0, 0],
  rotation: over.rotation ?? [0, 0, 0],
  scale: over.scale ?? [1, 1, 1],
  visible: true,
  ...over,
});

/** 示例布景：L 形客厅 + 外景道具 */
export function demoAssets(): SceneAsset[] {
  return [
    demo({
      instanceId: 'demo-wall-a',
      assetId: 'A-1001',
      name: '客厅主墙',
      code: 'SET_WALL_A',
      kind: 'wall',
      size: [8, 3.2, 0.24],
      color: '#6b7787',
      position: [0, 0, -4],
    }),
    demo({
      instanceId: 'demo-wall-b',
      assetId: 'A-1002',
      name: '隔断矮墙',
      code: 'SET_WALL_B',
      kind: 'wall',
      size: [4, 2.4, 0.24],
      color: '#5f6a79',
      position: [-4, 0, -2],
      rotation: [0, Math.PI / 2, 0],
    }),
    demo({
      instanceId: 'demo-table',
      assetId: 'A-1003',
      name: '餐桌',
      code: 'PROP_TABLE',
      kind: 'box',
      size: [2.0, 0.78, 1.0],
      color: '#8a6a4f',
      position: [0, 0, -2.6],
    }),
    demo({
      instanceId: 'demo-sofa',
      assetId: 'A-1008',
      name: '双人沙发',
      code: 'PROP_SOFA',
      kind: 'box',
      size: [2.2, 0.85, 0.95],
      color: '#6d5b8a',
      position: [-2.4, 0, -3.2],
    }),
    demo({
      instanceId: 'demo-person',
      assetId: 'A-1005',
      name: '演员替身（男）',
      code: 'CHR_STANDIN_M',
      kind: 'person',
      size: [0.56, 1.75, 0.4],
      color: '#c9a227',
      position: [1.1, 0, -2.2],
      rotation: [0, -0.4, 0],
    }),
    demo({
      instanceId: 'demo-column',
      assetId: 'A-1004',
      name: '结构立柱',
      code: 'SET_COLUMN',
      kind: 'column',
      size: [0.45, 3.2, 0.45],
      color: '#77828f',
      position: [3.4, 0, -3.4],
    }),
    demo({
      instanceId: 'demo-car',
      assetId: 'A-1006',
      name: '主道具车',
      code: 'PROP_CAR_01',
      kind: 'vehicle',
      size: [4.4, 1.45, 1.85],
      color: '#2f6f8f',
      position: [8.2, 0, -1.4],
      rotation: [0, 1.15, 0],
    }),
    demo({
      instanceId: 'demo-tree',
      assetId: 'A-1007',
      name: '外景乔木',
      code: 'ENV_TREE',
      kind: 'tree',
      size: [2.2, 3.0, 2.2],
      color: '#3f7d4a',
      position: [-6.4, 0, 2.2],
    }),
  ];
}

export const DEMO_SHOT: ShotCamera = {
  position: [7.2, 1.65, 7.2],
  yaw: 45,
  pitch: -6,
  roll: 0,
  focal: 35,
  sensor: 'S35',
  aspect: '2.39:1',
  rig: '三脚架',
  sceneNo: 'S12',
  shotNo: 'S12-C1',
  notes: '客厅全景，机位需避开立柱；轨道预留在门外。',
};

export const PROJECT_INFO = {
  projectName: '示例项目 · 《逆光》',
  episode: 'EP01',
  department: '技术预演组',
};
