import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as THREE from 'three';
import { Line, TransformControls } from '@react-three/drei';
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { useScene, markGizmoDragEnd } from '../../store/sceneStore';
import { lensMathNum } from '../../lib/lens';
import { pivotShift, rotatePoseY, shotPoseAt } from '../../lib/previz';
import { ASPECTS, type SceneAsset } from '../../types';
import { AnimatedActor } from './AnimatedActor';

/** 仅展示页：三维内编辑（gizmo 拖拽/棚位置拖动）全局停用开关，改 true 即整体恢复 */
const EDITING_ENABLED: boolean = false;

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

/**
 * 环屏投屏层：直接复用右下角 take 小窗的 <video> 作为贴图，
 * 播放/暂停/进度/倍速天然同步，相当于把环屏当成虚拟拍摄的 LED 墙。
 *
 * 画面只落在当前机位视锥真正覆盖到的那一段环屏上（真正的虚拟拍摄 LED 墙逻辑），
 * 而不是把 take 画面平铺一整圈：按片元世界坐标投影到机位相机里，
 * 落在视锥外（NDC 超出 [-1,1]）的位置直接丢弃，露出环屏底色。
 */
function LedVideoScreen({
  radius,
  height,
  thetaStart,
  thetaLength,
}: {
  radius: number;
  height: number;
  thetaStart: number;
  thetaLength: number;
}) {
  const video = useScene((s) => s.takeVideoEl);

  const texture = useMemo(() => {
    if (!video) return null;
    const next = new THREE.VideoTexture(video);
    next.colorSpace = THREE.SRGBColorSpace;
    next.wrapS = THREE.ClampToEdgeWrapping;
    next.wrapT = THREE.ClampToEdgeWrapping;
    return next;
  }, [video]);

  const uniforms = useMemo(
    () => ({
      uMap: { value: texture },
      uViewProj: { value: new THREE.Matrix4() },
      uUseProject: { value: 0 },
    }),
    [texture],
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        transparent: false,
        side: THREE.BackSide,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          uniform mat4 uViewProj;
          uniform float uUseProject;
          varying vec3 vWorld;
          varying vec2 vUv;
          void main() {
            vec2 texUv;
            if (uUseProject > 0.5) {
              // 世界坐标投影到当前机位：只有落在视锥内的环屏片段才显示画面
              vec4 clip = uViewProj * vec4(vWorld, 1.0);
              if (clip.w <= 0.0) discard;
              vec2 ndc = clip.xy / clip.w;
              if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) discard;
              texUv = ndc * 0.5 + 0.5;
              // VideoTexture 默认 flipY=true（v=0 对应画面底部），NDC y 轴同向，无需再翻转
            } else {
              // 未选镜头时退回整圈平铺，从环内看圆柱背面需要翻转 U
              texUv = vec2(1.0 - vUv.x, vUv.y);
            }
            gl_FragColor = vec4(texture2D(uMap, texUv).rgb, 1.0);
            #include <colorspace_fragment>
          }
        `,
      }),
    [uniforms],
  );

  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => texture?.dispose(), [texture]);

  const cam = useMemo(() => new THREE.PerspectiveCamera(), []);
  const viewProj = useMemo(() => new THREE.Matrix4(), []);

  useFrame(() => {
    if (!texture) return;
    // 暂停/未开播时视频不再派发新帧（rVFC 不触发），手动标记上传当前帧，避免环屏黑屏
    if (video && video.readyState >= video.HAVE_CURRENT_DATA) texture.needsUpdate = true;
    const st = useScene.getState();
    const shot = st.activeShotId
      ? (st.previz?.shots.find((item) => item.id === st.activeShotId) ?? null)
      : null;
    const raw = shot ? shotPoseAt(shot, st.timelineTime) : null;
    // 与机位取景/主视口解算保持同一坐标系：置景平移先于集合转向生效（绕锚点转向用等效平移）
    const pose = raw
      ? rotatePoseY(raw, st.ensembleYaw, pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw))
      : null;

    if (!pose) {
      uniforms.uUseProject.value = 0;
      return;
    }

    // 投影视锥画幅与 take 视频保持一致（机位取景同基准），无 take 时回落相机参数画幅
    const takeEl = st.takeVideoEl;
    const frameAspect =
      takeEl && takeEl.videoWidth > 0 && takeEl.videoHeight > 0
        ? takeEl.videoWidth / takeEl.videoHeight
        : ASPECTS[st.camera.aspect];
    const lens = lensMathNum(pose.focal ?? st.camera.focal, st.camera.sensor, frameAspect);
    const aspect = Math.tan(lens.hfov / 2) / Math.max(1e-4, Math.tan(lens.vfov / 2));
    cam.fov = THREE.MathUtils.radToDeg(lens.vfov);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(
      THREE.MathUtils.degToRad(pose.pitch),
      THREE.MathUtils.degToRad(pose.yaw),
      0,
    );
    cam.updateMatrixWorld(true);

    viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    uniforms.uViewProj.value.copy(viewProj);
    uniforms.uUseProject.value = 1;
  });

  if (!texture) return null;

  return (
    <mesh position={[0, height / 2, 0]} raycast={() => null}>
      <cylinderGeometry
        args={[radius - 0.02, radius - 0.02, height, 256, 1, true, thetaStart, thetaLength]}
      />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/** 环屏棚：按直径 / 高度 / 覆盖角度程序化生成，规格来自后端扫描 UE 工程 NDC 目录 */
export function LedRing({
  position = [0, 0, 0],
  diameter,
  height,
  arc,
  gapCenterDeg = 90,
}: {
  /** 环心整体位置（米），默认原点 */
  position?: [number, number, number];
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

  // 位置编辑模式：环心出现移动 gizmo，拖动松手后把位置写回 store；
  // 点击环屏本体也可进入编辑，点空白处退出（见 Viewport 的 onPointerMissed）
  const editing = useScene((s) => s.stagePosEditing);
  const setStagePosEditing = useScene((s) => s.setStagePosEditing);
  const groupRef = useRef<THREE.Group | null>(null);
  const [object, setObject] = useState<THREE.Group | null>(null);
  const attach = useCallback((node: THREE.Group | null) => {
    groupRef.current = node;
    setObject(node);
  }, []);
  const commit = useCallback(() => {
    const node = groupRef.current;
    markGizmoDragEnd();
    if (!node) return;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    useScene
      .getState()
      .setStagePosition([r(node.position.x), r(node.position.y), r(node.position.z)]);
  }, []);

  return (
    <>
      <group
        ref={attach}
        position={position}
        onClick={(event) => {
          event.stopPropagation();
          // 测量模式下点击环屏是打测量点，不进入位置编辑
          if (useScene.getState().mode !== 'measure') setStagePosEditing(true);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'move';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
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
      {/* 投屏层：有 take 视频时把画面贴到环屏内侧 */}
      <LedVideoScreen
        radius={radius}
        height={height}
        thetaStart={thetaStart}
        thetaLength={thetaLength}
      />
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
      {/* 环屏位置编辑：点击环屏进入，拖 gizmo 移动，点空白退出（资产 gizmo 仍由 EDITING_ENABLED 控制） */}
      {editing && object && (
        <TransformControls
          object={object}
          mode="translate"
          space="world"
          translationSnap={0.1}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

/**
 * 灯位标记：发光小球 + 光照方向示意。
 * 点光/面光画淡色衰减范围球；聚光画照射锥，定向灯画方向虚线。
 * UE 灯默认朝 Actor -X，经基变换（x_ue → -Z）后在 three 空间默认朝 +Z。
 */
function LightMarker({ asset }: { asset: SceneAsset }) {
  const color = asset.color || '#ffd9a0';
  const type = asset.lightType ?? 'Light';
  const isSpot = /spot/i.test(type);
  const isDir = /directional/i.test(type);
  const hasDirection = isSpot || isDir;
  const range = asset.lightRange ?? 3;

  const dir = useMemo(() => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...asset.rotation, 'XYZ'));
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  }, [asset.rotation]);

  // 聚光锥：灯到照射方向 range 处的圆周（8 点）
  const cone = useMemo(() => {
    if (!isSpot) return null;
    const outerDeg = asset.outerConeDeg ?? 35;
    const r = Math.max(0.05, range * Math.sin(THREE.MathUtils.degToRad(outerDeg)));
    const tip = dir.clone().multiplyScalar(range);
    const basis = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, basis).normalize();
    const v = new THREE.Vector3().crossVectors(dir, u);
    const ring: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const p = tip.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
      ring.push([p.x, p.y, p.z]);
    }
    ring.push(ring[0]);
    return { ring };
  }, [isSpot, dir, range, asset.outerConeDeg]);

  const end = useMemo(() => {
    const p = dir.clone().multiplyScalar(Math.min(range, 1.2));
    return [p.x, p.y, p.z] as [number, number, number];
  }, [dir, range]);

  return (
    <group>
      {/* 灯泡本体 + 外圈淡光晕，可点选 */}
      <mesh>
        <sphereGeometry args={[0.09, 16, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {/* 点光/面光：淡色衰减范围球 */}
      {!hasDirection && (
        <mesh>
          <sphereGeometry args={[Math.min(range, 8), 20, 14]} />
          <meshBasicMaterial color={color} transparent opacity={0.04} depthWrite={false} />
        </mesh>
      )}
      {isDir && <Line points={[[0, 0, 0], end]} color={color} lineWidth={1.5} dashed dashSize={0.12} gapSize={0.08} />}
      {cone && (
        <group>
          {cone.ring.slice(0, 8).map((p, i) => (
            <Line key={i} points={[[0, 0, 0], p]} color={color} lineWidth={1} transparent opacity={0.5} />
          ))}
          <Line points={cone.ring} color={color} lineWidth={1.5} transparent opacity={0.8} />
        </group>
      )}
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
    /* 基础模型：球体（添加模型入口用） */
    case 'sphere':
      return (
        <mesh position={[0, Math.max(size[0], size[1], size[2]) / 2, 0]} castShadow receiveShadow>
          <sphereGeometry args={[Math.max(size[0], size[1], size[2]) / 2, 24, 16]} />
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
    case 'light':
      return <LightMarker asset={asset} />;
    case 'skeletal':
      return asset.animUrl ? (
        <Suspense
          fallback={
            <mesh position={[0, size[1] / 2, 0]}>
              <boxGeometry args={size} />
              <meshStandardMaterial color={color} wireframe />
            </mesh>
          }
        >
          <AnimatedActor animUrl={asset.animUrl} animOffset={asset.animOffset} height={size[1]} clothColor={asset.color} />
        </Suspense>
      ) : null;
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
  forceHidden = false,
}: {
  asset: SceneAsset;
  /** 镜头库选中镜头时：本镜头用到的元素一律显示，不受场景大纲里的手工隐藏影响 */
  forceVisible?: boolean;
  /** 镜头模式下的手工隐藏：优先级高于 forceVisible，用于在单个镜头里单独剔除某个元素 */
  forceHidden?: boolean;
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

  /** 最终显隐：镜头强制显示 / 大纲手工显示，再被「本镜头手工隐藏」盖掉 */
  const visible = (asset.visible || forceVisible) && !forceHidden;

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
    const next = visible && !hide;
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
        visible={visible}
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
      {/* gizmo 独立挂载，不再包裹 children；编辑已停用（仅展示页），EDITING_ENABLED 改 true 恢复 */}
      {EDITING_ENABLED && selected && object && mode !== 'measure' && visible && (
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
