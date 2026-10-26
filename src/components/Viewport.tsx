import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, OrbitControls, Line } from '@react-three/drei';
import { useScene, isGizmoActive } from '../store/sceneStore';
import { SceneObject, LedRing } from './scene/SceneObject';
import { CameraRig } from './scene/CameraRig';
import { SetPlanLayer } from './scene/SetPlanLayer';
import { MeasurementLayer } from './scene/MeasurementLayer';
import { PeopleLayer } from './scene/PeopleLayer';
import { TakePlayer } from './TakePlayer';
import { ASPECTS } from '../types';
import { frameFractions, lensMath } from '../lib/lens';
import { shotAt, sampleShotAtTime, shotLabel } from '../lib/previz';
import { viewportBridge } from '../lib/viewportBridge';

function Bridge() {
  const { camera, gl } = useThree();
  useEffect(() => {
    viewportBridge.camera = camera as THREE.PerspectiveCamera;
    viewportBridge.canvas = gl.domElement;
  }, [camera, gl]);
  return null;
}

/** 机位模式下用镜头参数驱动画布相机，并保持水平视角与画幅一致 */
function CameraDriver() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const saved = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion } | null>(null);
  const lastMode = useRef(mode);

  useEffect(() => {
    if (mode === 'camera' && lastMode.current !== 'camera') {
      saved.current = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
      };
    } else if (mode !== 'camera' && lastMode.current === 'camera') {
      if (saved.current) {
        camera.position.copy(saved.current.position);
        camera.quaternion.copy(saved.current.quaternion);
      }
      camera.fov = 48;
      camera.updateProjectionMatrix();
    }
    lastMode.current = mode;
  }, [mode, camera]);

  useFrame(() => {
    if (mode !== 'camera') {
      if (Math.abs(camera.fov - 48) > 0.01) {
        camera.fov = 48;
        camera.updateProjectionMatrix();
      }
      return;
    }
    const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
    const canvasAspect = size.width / Math.max(1, size.height);
    const frame = frameFractions(canvasAspect, ASPECTS[shot.aspect]);
    const camVfov = 2 * Math.atan(Math.tan(lens.vfov / 2) / frame.heightFraction);

    camera.position.set(...shot.position);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(shot.pitch),
      THREE.MathUtils.degToRad(shot.yaw),
      THREE.MathUtils.degToRad(shot.roll),
    );

    const fovDeg = THREE.MathUtils.radToDeg(camVfov);
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

/** 播放时间线驱动：开启「跟随机位」时，画布相机沿预演机位飞行（不写 store，避免误触发自动保存） */
function PrevizPlayback() {
  const follow = useScene((s) => s.followPreviz);
  const mode = useScene((s) => s.mode);
  const aimMode = useScene((s) => s.aimMode);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const saved = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number } | null>(null);
  const active = useRef(false);

  useFrame(() => {
    const shouldFollow = follow && mode !== 'camera';
    if (!shouldFollow) {
      // 高空视角由 AerialRig 接管相机，这里不能把相机恢复成进入跟随前的旧位置
      const aerial = useScene.getState().aerialView;
      if (!aerial && active.current && saved.current) {
        camera.position.copy(saved.current.position);
        camera.quaternion.copy(saved.current.quaternion);
        camera.fov = saved.current.fov;
        camera.updateProjectionMatrix();
      }
      active.current = false;
      saved.current = null;
      return;
    }
    if (!active.current) {
      saved.current = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov };
      active.current = true;
    }
    const st = useScene.getState();
    const tl = st.previz;
    if (!tl) return;
    const shot = shotAt(tl.shots, st.timelineTime);
    if (!shot) return; // 镜头间隙保持上一帧
    const pose = sampleShotAtTime(shot, st.timelineTime);
    if (!pose) return;

    // 计算后：整条 take 加固定偏航/俯仰角，把视线摆向 LED 环屏（缺口位置不动）
    const aim = aimMode === 'led' ? st.shotAim?.shots.find((row) => row.id === shot.id) : null;
    const yaw = pose.yaw + (aim?.deltaDeg ?? 0);
    const pitch = pose.pitch + (aim?.deltaPitchDeg ?? 0);

    camera.position.set(...pose.position);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      THREE.MathUtils.degToRad(pitch),
      THREE.MathUtils.degToRad(yaw),
      0,
    );

    const lens = lensMath(pose.focal ?? st.camera.focal, st.camera.sensor, st.camera.aspect);
    const canvasAspect = size.width / Math.max(1, size.height);
    const frame = frameFractions(canvasAspect, ASPECTS[st.camera.aspect]);
    const fovDeg = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(lens.vfov / 2) / frame.heightFraction));
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

/** 高空视角：切到场景上方俯视，便于观察机位怎么运转；退出时恢复原相机位姿 */
function AerialRig() {
  const aerial = useScene((s) => s.aerialView);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;
  const saved = useRef<{ pos: THREE.Vector3; fov: number; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (aerial) {
      saved.current = {
        pos: camera.position.clone(),
        fov: camera.fov,
        target: controls ? controls.target.clone() : new THREE.Vector3(),
      };
      camera.position.set(0, 34, 30);
      camera.fov = 48;
      camera.updateProjectionMatrix();
      camera.lookAt(0, 1, 0);
      if (controls) {
        controls.target.set(0, 1, 0);
        controls.update();
      }
      return;
    }
    const prev = saved.current;
    if (!prev) return;
    camera.position.copy(prev.pos);
    camera.fov = prev.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(prev.target);
    if (controls) {
      controls.target.copy(prev.target);
      controls.update();
    }
    saved.current = null;
  }, [aerial, camera, controls]);

  return null;
}

/** 高空视角下显示当前镜头机位：黄色轨迹 + 随时间移动的机位标记与视锥 */
function PrevizCameraMarker() {
  const aerial = useScene((s) => s.aerialView);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const aimMode = useScene((s) => s.aimMode);
  const shotAim = useScene((s) => s.shotAim);
  const ref = useRef<THREE.Group>(null);

  const shot = useMemo(
    () => (activeShotId ? (previz?.shots.find((s) => s.id === activeShotId) ?? null) : null),
    [previz, activeShotId],
  );
  const trail = useMemo(
    () => (shot ? shot.keys.map((k) => new THREE.Vector3(...k.position)) : []),
    [shot],
  );

  useFrame(() => {
    const group = ref.current;
    if (!group || !shot) return;
    const pose = sampleShotAtTime(shot, useScene.getState().timelineTime);
    if (!pose) return;
    // 与跟随播放同口径：朝环屏模式下整条 take 叠加固定偏航/俯仰修正
    const aim = aimMode === 'led' ? shotAim?.shots.find((row) => row.id === shot.id) : null;
    group.position.set(...pose.position);
    group.rotation.order = 'YXZ';
    group.rotation.set(
      THREE.MathUtils.degToRad(pose.pitch + (aim?.deltaPitchDeg ?? 0)),
      THREE.MathUtils.degToRad(pose.yaw + (aim?.deltaDeg ?? 0)),
      0,
    );
  });

  if (!aerial || !shot) return null;

  return (
    <>
      {trail.length > 1 && (
        <Line points={trail} color="#ffb020" lineWidth={2} dashed dashSize={0.8} gapSize={0.5} />
      )}
      <group ref={ref}>
        <mesh>
          <boxGeometry args={[0.5, 0.36, 0.8]} />
          <meshStandardMaterial color="#ffb020" emissive="#ffb020" emissiveIntensity={0.45} />
        </mesh>
        <mesh position={[0, 0, -1.6]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.55, 2.6, 4, 1, true]} />
          <meshBasicMaterial color="#ffb020" wireframe transparent opacity={0.5} />
        </mesh>
      </group>
    </>
  );
}

function Ground() {
  const mode = useScene((s) => s.mode);
  const addMeasurePoint = useScene((s) => s.addMeasurePoint);
  const selectAsset = useScene((s) => s.selectAsset);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (mode === 'measure') {
      addMeasurePoint([event.point.x, event.point.y, event.point.z]);
      return;
    }
    if (mode === 'camera') return;
    // 刚结束 gizmo 拖拽时的 click 不视为“点空白”
    if (isGizmoActive()) return;
    selectAsset(null);
  };

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.015, 0]} receiveShadow onClick={handleClick}>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#131a23" roughness={0.98} metalness={0} />
    </mesh>
  );
}

function SceneContent() {
  const assets = useScene((s) => s.assets);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const aerial = useScene((s) => s.aerialView);
  const mode = useScene((s) => s.mode);
  const follow = useScene((s) => s.followPreviz);
  const stages = useScene((s) => s.stages);
  const currentStageId = useScene((s) => s.currentStageId);
  const activeShotId = useScene((s) => s.activeShotId);
  const previz = useScene((s) => s.previz);
  const stage = stages.find((s) => s.id === currentStageId);
  const activeShot = activeShotId
    ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
    : null;

  // 镜头库选中某个镜头时，只渲染该镜头视锥内用到的元素（高空视角也一样，便于只看本镜头布景与机位运动）
  const visibleAssets = useMemo(() => {
    if (!usedIds) return assets;
    const used = new Set(usedIds);
    return assets.filter((asset) => used.has(asset.instanceId));
  }, [assets, usedIds]);

  return (
    <>
      <color attach="background" args={['#0b1016']} />
      <fog attach="fog" args={['#0b1016', 55, 150]} />
      <hemisphereLight args={['#cfe3ff', '#161d27', 0.85]} />
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[16, 22, 12]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-bias={-0.0005}
      />
      <Ground />
      {/* 棚：固定于原点，仅可通过顶栏切换，不参与选中/变换 */}
      {stage && (
        <LedRing
          diameter={stage.diameter}
          height={stage.height}
          arc={stage.arc}
          gapCenterDeg={stage.gapCenterDeg}
        />
      )}
      <Grid
        position={[0, 0.002, 0]}
        args={[120, 120]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#26313f"
        sectionSize={5}
        sectionThickness={1.1}
        sectionColor="#3b4a5d"
        fadeDistance={75}
        fadeStrength={1.2}
        infiniteGrid
        raycast={() => null}
      />
      {visibleAssets.map((asset) => (
        <SceneObject
          key={asset.instanceId}
          asset={asset}
          forceVisible={Boolean(usedIds)}
        />
      ))}
      <MeasurementLayer />
      <SetPlanLayer />
      <PeopleLayer shot={activeShot} />
      <CameraRig />
      <CameraDriver />
      <PrevizPlayback />
      <AerialRig />
      <PrevizCameraMarker />
      <Bridge />
      <OrbitControls
        enabled={mode !== 'camera' && !follow}
        makeDefault
        target={aerial ? [0, 1, 0] : [0, 3, -1]}
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.02}
        minDistance={1}
        maxDistance={80}
      />
    </>
  );
}

/** 机位模式的画幅遮罩，按画布与目标画幅比例计算黑边 */
function FrameOverlay() {
  const aspectKey = useScene((s) => s.camera.aspect);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!size.width || !size.height) return <div ref={ref} className="frame-overlay" />;

  const frame = frameFractions(size.width / size.height, ASPECTS[aspectKey]);

  return (
    <div ref={ref} className="frame-overlay">
      <div
        className="frame-window"
        style={{ width: `${frame.widthFraction * 100}%`, height: `${frame.heightFraction * 100}%` }}
      >
        <span className="frame-corner tl" />
        <span className="frame-corner tr" />
        <span className="frame-corner bl" />
        <span className="frame-corner br" />
        <span className="frame-third v1" />
        <span className="frame-third v2" />
        <span className="frame-third h1" />
        <span className="frame-third h2" />
        <span className="frame-cross" />
      </div>
    </div>
  );
}

function Readout() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
  const coverage = lens.coverageAt(5);

  return (
    <div className="viewport-readout">
      <div className="readout-main">
        <span className="mono">{shot.focal}mm</span>
        <span>{shot.aspect}</span>
        <span className="mono">H {shot.position[1].toFixed(2)}m</span>
      </div>
      <div className="readout-sub">
        水平视角 {lens.hfovDeg.toFixed(1)}° · 垂直 {lens.vfovDeg.toFixed(1)}° · 5m 处画面{' '}
        {coverage.width.toFixed(2)}×{coverage.height.toFixed(2)}m
      </div>
      {mode === 'measure' && (
        <div className="readout-hint">依次点击两个位置完成测量（可点在资产表面）</div>
      )}
    </div>
  );
}

function HoverName() {
  const hoveredId = useScene((s) => s.hoveredId);
  const asset = useScene((s) => (s.hoveredId ? s.assets.find((a) => a.instanceId === s.hoveredId) : null));
  if (!hoveredId || !asset) return null;
  return (
    <div className="hover-name">
      <b>{asset.name}</b>
      <span>{asset.code}</span>
      {asset.meshUrl ? <em>真实网格</em> : <em className="proxy">代理体块</em>}
    </div>
  );
}

export function Viewport() {
  const mode = useScene((s) => s.mode);
  const aerial = useScene((s) => s.aerialView);
  const toggleAerialView = useScene((s) => s.toggleAerialView);
  const selectAsset = useScene((s) => s.selectAsset);
  const activeShotId = useScene((s) => s.activeShotId);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const assets = useScene((s) => s.assets);
  const previz = useScene((s) => s.previz);
  const activeShot = activeShotId
    ? (previz?.shots.find((shot) => shot.id === activeShotId) ?? null)
    : null;

  return (
    <div className="viewport">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: [0, 10, 17], fov: 48, near: 0.1, far: 400 }}
        onPointerMissed={() => {
          if (!isGizmoActive()) selectAsset(null);
        }}
      >
        <SceneContent />
      </Canvas>
      {mode === 'camera' && <FrameOverlay />}
      <Readout />
      <HoverName />
      <TakePlayer />
      {aerial && (
        <div className="shot-filter-badge">
          <b>高空视角</b>
          <span>俯视观察机位运动 · 黄色虚线为机位轨迹</span>
        </div>
      )}
      {!aerial && activeShot && usedIds && (
        <div className="shot-filter-badge">
          <b>{shotLabel(activeShot)}</b>
          <span>
            本镜头元素 {usedIds.length} / {assets.length} · 其余已按视锥剔除
          </span>
        </div>
      )}
      <div className={`mode-badge ${mode}`}>
        {aerial
          ? '高空视角'
          : mode === 'orbit'
            ? '自由视角'
            : mode === 'camera'
              ? '机位取景'
              : '测量模式'}
      </div>
      <div className="viewport-actions">
        <button
          className={`aerial-toggle ${aerial ? 'active' : ''}`}
          onClick={toggleAerialView}
          title="不跟随镜头，从场景上方俯视观察机位怎么运动（黄色虚线为机位轨迹）"
        >
          {aerial ? '退出高空视角' : '高空视角'}
        </button>
      </div>
    </div>
  );
}
