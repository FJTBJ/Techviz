import { Component, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { useScene, markGizmoDragEnd } from '../../store/sceneStore';
import type { SceneAsset } from '../../types';

/** 模型加载失败（文件没部署/路径失效）时回退到代理体块，避免整块画布崩掉 */
class ModelBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** UE 导出的模型经过 meshopt 压缩，需要显式挂解码器 */
class MeshoptGLTFLoader extends GLTFLoader {
  constructor(manager?: THREE.LoadingManager) {
    super(manager);
    this.setMeshoptDecoder(MeshoptDecoder);
  }
}

function GltfModel({ url }: { url: string }) {
  const gltf = useLoader(MeshoptGLTFLoader, url) as unknown as GLTF;
  const cloned = useMemo(() => {
    const scene = gltf.scene.clone(true);
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return scene;
  }, [gltf.scene]);
  return <primitive object={cloned} />;
}

/** 环屏棚：按直径 / 高度 / 覆盖角度程序化生成，规格来自后端扫描 UE 工程 NDC 目录 */
export function LedRing({
  diameter,
  height,
  arc,
  gapCenterDeg = 90,
}: {
  diameter: number;
  height: number;
  arc: number;
  gapCenterDeg?: number;
}) {
  const arcDeg = arc;
  const radius = diameter / 2;
  const gapDeg = 360 - arcDeg;
  const thetaStart = THREE.MathUtils.degToRad(gapCenterDeg + gapDeg / 2);
  const thetaLength = THREE.MathUtils.degToRad(arcDeg);
  const segs = 128;

  return (
    <group>
      {/* 主屏体：通电状态的暗蓝发光 */}
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, height, segs, 1, true, thetaStart, thetaLength]} />
        <meshStandardMaterial
          color="#0d1118"
          roughness={0.42}
          metalness={0.35}
          side={THREE.DoubleSide}
          emissive="#2a4a7f"
          emissiveIntensity={0.35}
        />
      </mesh>
      {/* 顶部桁架环带 */}
      <mesh position={[0, height + 0.28, 0]} castShadow>
        <cylinderGeometry
          args={[radius + 0.42, radius + 0.42, 0.56, segs, 1, true, thetaStart, thetaLength]}
        />
        <meshStandardMaterial color="#39424f" roughness={0.55} metalness={0.5} side={THREE.DoubleSide} />
      </mesh>
      {/* 底部基座环带 */}
      <mesh position={[0, 0.18, 0]} castShadow>
        <cylinderGeometry
          args={[radius + 0.3, radius + 0.34, 0.36, segs, 1, true, thetaStart, thetaLength]}
        />
        <meshStandardMaterial color="#2a323d" roughness={0.8} metalness={0.3} side={THREE.DoubleSide} />
      </mesh>
      {/* 缺口两侧端柱：cylinder 的 theta 从 +Z 起算向 +X 方向展开 */}
      {[thetaStart, thetaStart + thetaLength].map((theta) => (
        <mesh
          key={theta}
          position={[radius * Math.sin(theta), height / 2, radius * Math.cos(theta)]}
          castShadow
        >
          <boxGeometry args={[0.5, height + 0.6, 0.5]} />
          <meshStandardMaterial color="#39424f" roughness={0.55} metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function ProxyMesh({ asset }: { asset: SceneAsset }) {
  const { kind, size, color } = asset;
  const surface = <meshStandardMaterial color={color} roughness={0.7} metalness={0.08} />;

  switch (kind) {
    case 'wall':
    case 'box':
      return (
        <mesh position={[0, size[1] / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={size} />
          {surface}
        </mesh>
      );
    /* UE 导入构件：优先用从 UE 导出的真实网格（GLB），没有模型时回退包围盒 */
    case 'ue': {
      const [ox, oy, oz] = asset.offset ?? [0, 0, 0];
      // size / offset 已是世界尺度，而外层 group 又带 asset.scale，回退盒需要先除回去
      const [gx, gy, gz] = asset.scale.map((v) => (v === 0 ? 1 : Math.abs(v)));
      const localSize: [number, number, number] = [size[0] / gx, size[1] / gy, size[2] / gz];
      const localOffset: [number, number, number] = [
        ox / (asset.scale[0] || 1),
        oy / (asset.scale[1] || 1),
        oz / (asset.scale[2] || 1),
      ];
      // 立柱（ZhuZi 系列）用圆柱表达，其余用包围盒
      const isColumn = /ZHUZI/i.test(asset.code);
      const proxy = (
        <mesh position={localOffset} castShadow receiveShadow>
          {isColumn ? (
            <cylinderGeometry
              args={[
                Math.max(localSize[0], localSize[2]) / 2,
                Math.max(localSize[0], localSize[2]) / 2,
                localSize[1],
                20,
              ]}
            />
          ) : (
            <boxGeometry args={localSize} />
          )}
          {surface}
        </mesh>
      );
      if (asset.meshUrl) {
        return (
          <ModelBoundary fallback={proxy}>
            <Suspense fallback={proxy}>
              <GltfModel url={asset.meshUrl} />
            </Suspense>
          </ModelBoundary>
        );
      }
      return proxy;
    }
    case 'column':
      return (
        <mesh position={[0, size[1] / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[size[0] / 2, size[0] / 2, size[1], 24]} />
          {surface}
        </mesh>
      );
    case 'person': {
      const radius = Math.min(size[0], size[2]) / 2;
      const length = Math.max(0.2, size[1] - radius * 2);
      return (
        <mesh position={[0, size[1] / 2, 0]} castShadow receiveShadow>
          <capsuleGeometry args={[radius, length, 8, 20]} />
          {surface}
        </mesh>
      );
    }
    case 'vehicle':
      return (
        <group>
          <mesh position={[0, size[1] * 0.3, 0]} castShadow receiveShadow>
            <boxGeometry args={[size[0], size[1] * 0.6, size[2]]} />
            {surface}
          </mesh>
          <mesh position={[0, size[1] * 0.75, -size[2] * 0.05]} castShadow>
            <boxGeometry args={[size[0] * 0.52, size[1] * 0.5, size[2] * 0.82]} />
            <meshStandardMaterial color="#1b2733" roughness={0.35} metalness={0.2} />
          </mesh>
        </group>
      );
    case 'tree':
      return (
        <group>
          <mesh position={[0, size[1] * 0.25, 0]} castShadow>
            <cylinderGeometry args={[size[0] * 0.06, size[0] * 0.08, size[1] * 0.5, 10]} />
            <meshStandardMaterial color="#5b4531" roughness={0.95} />
          </mesh>
          <mesh position={[0, size[1] * 0.68, 0]} castShadow>
            <sphereGeometry args={[size[0] * 0.42, 20, 14]} />
            {surface}
          </mesh>
        </group>
      );
    case 'glb':
      return asset.url ? (
        <Suspense
          fallback={
            <mesh position={[0, size[1] / 2, 0]}>
              <boxGeometry args={size} />
              <meshStandardMaterial color={color} wireframe />
            </mesh>
          }
        >
          <GltfModel url={asset.url} />
        </Suspense>
      ) : null;
    default:
      return null;
  }
}

export function SceneObject({
  asset,
  forceVisible = false,
}: {
  asset: SceneAsset;
  /** 镜头库选中镜头时：本镜头用到的元素一律显示，不受场景大纲里的手工隐藏影响 */
  forceVisible?: boolean;
}) {
  const selectedId = useScene((s) => s.selectedId);
  const mode = useScene((s) => s.mode);
  const gizmo = useScene((s) => s.gizmo);
  const selectAsset = useScene((s) => s.selectAsset);
  const hoverAsset = useScene((s) => s.hoverAsset);
  const updateAsset = useScene((s) => s.updateAsset);
  const addMeasurePoint = useScene((s) => s.addMeasurePoint);
  const followPreviz = useScene((s) => s.followPreviz);

  const groupRef = useRef<THREE.Group | null>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [dragging, setDragging] = useState(false);

  // 预演机位常贴着甚至钻进 UE 体块的包围盒（包围盒比真实网格粗），
  // 这时该体块的内壁阴影会把整个画面糊黑，跟随时隐藏包住相机的那一块。
  useFrame(({ camera }) => {
    const node = groupRef.current;
    if (!node) return;
    const p = camera.position;
    const [ox, oy, oz] = asset.offset ?? [0, 0, 0];
    const [sx, sy, sz] = asset.scale;
    const cx = asset.position[0] + ox * sx;
    const cy = asset.position[1] + oy * sy;
    const cz = asset.position[2] + oz * sz;
    let hide = false;
    if (followPreviz) {
      if (/ZHUZI/i.test(asset.code)) {
        const r = Math.max(asset.size[0] * sx, asset.size[2] * sz) / 2;
        hide =
          (p.x - cx) ** 2 + (p.z - cz) ** 2 <= r * r &&
          Math.abs(p.y - cy) <= Math.abs(asset.size[1] * sy) / 2;
      } else {
        const dx = p.x - cx;
        const dz = p.z - cz;
        const cos = Math.cos(-asset.rotation[1]);
        const sin = Math.sin(-asset.rotation[1]);
        hide =
          Math.abs(dx * cos - dz * sin) <= Math.abs(asset.size[0] * sx) / 2 &&
          Math.abs(p.y - cy) <= Math.abs(asset.size[1] * sy) / 2 &&
          Math.abs(dx * sin + dz * cos) <= Math.abs(asset.size[2] * sz) / 2;
      }
    }
    const next = (asset.visible || forceVisible) && !hide;
    if (node.visible !== next) node.visible = next;
  });

  const attach = useCallback((node: THREE.Group | null) => {
    groupRef.current = node;
    setObject(node);
  }, []);

  const selected = selectedId === asset.instanceId;

  const commit = useCallback(() => {
    const node = groupRef.current;
    markGizmoDragEnd();
    if (!node) {
      setDragging(false);
      return;
    }
    const r = (n: number) => Math.round(n * 1000) / 1000;
    updateAsset(asset.instanceId, {
      position: [r(node.position.x), r(node.position.y), r(node.position.z)],
      rotation: [r(node.rotation.x), r(node.rotation.y), r(node.rotation.z)],
      scale: [r(node.scale.x), r(node.scale.y), r(node.scale.z)],
    });
    setDragging(false);
  }, [asset.instanceId, updateAsset]);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (dragging) return;
    event.stopPropagation();
    if (mode === 'measure') {
      addMeasurePoint([event.point.x, event.point.y, event.point.z]);
      return;
    }
    if (mode === 'camera') return;
    selectAsset(asset.instanceId);
  };

  // UE 体块：选中环贴在其包围盒水平中心、地面或盒底（都在 group 局部坐标系内，需除以缩放）
  const ueOffset = asset.offset ?? [0, 0, 0];
  const isUe = asset.kind === 'ue';
  const [sgx, sgy, sgz] = asset.scale.map((v) => (v === 0 ? 1 : Math.abs(v)));
  const rawRadius = Math.max(asset.size[0], asset.size[2]) / 2 + 0.25;
  const ringRadius = isUe ? Math.min(3, rawRadius) : rawRadius;
  const ringPos: [number, number, number] = isUe
    ? [
        ueOffset[0] / (asset.scale[0] || 1),
        Math.max(0.02, (ueOffset[1] - asset.size[1] / 2 + 0.02) / (asset.scale[1] || 1)),
        ueOffset[2] / (asset.scale[2] || 1),
      ]
    : [0, 0.02, 0];
  // 环形几何也在 group 内被缩放，半径按缩放换算回去，避免大缩放体块上的环变成巨型圆盘
  const ringScale = Math.max(1, Math.max(sgx, sgy, sgz));

  return (
    <>
      {/* group 常驻在场景中，避免选中时因父级变化被 React 卸载重建 */}
      <group
        ref={attach}
        position={asset.position}
        rotation={asset.rotation}
        scale={asset.scale}
        visible={asset.visible || forceVisible}
        onClick={handleClick}
        onPointerOver={(event) => {
          event.stopPropagation();
          hoverAsset(asset.instanceId);
        }}
        onPointerOut={() => {
          if (useScene.getState().hoveredId === asset.instanceId) hoverAsset(null);
        }}
      >
        <ProxyMesh asset={asset} />
        {selected && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={ringPos}>
            <ringGeometry args={[ringRadius / ringScale, (ringRadius + 0.08) / ringScale, 48]} />
            <meshBasicMaterial color="#ffb020" side={THREE.DoubleSide} transparent opacity={0.9} />
          </mesh>
        )}
      </group>
      {/* gizmo 独立挂载，不再包裹 children，attach 目标始终是同一个 group 节点 */}
      {selected && object && mode !== 'measure' && (asset.visible || forceVisible) && (
        <TransformControls
          object={object}
          mode={gizmo}
          space={gizmo === 'translate' ? 'world' : 'local'}
          translationSnap={0.1}
          rotationSnap={Math.PI / 36}
          scaleSnap={0.1}
          onMouseDown={() => setDragging(true)}
          onMouseUp={commit}
        />
      )}
    </>
  );
}
