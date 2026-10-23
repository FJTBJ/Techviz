import type * as THREE from 'three';

/** 让面板可以从外部访问画布相机与渲染器（取当前视角、截图） */
export const viewportBridge: {
  camera: THREE.PerspectiveCamera | null;
  canvas: HTMLCanvasElement | null;
} = {
  camera: null,
  canvas: null,
};
