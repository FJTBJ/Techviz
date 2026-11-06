import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useScene } from '../../store/sceneStore';
import { lensMath } from '../../lib/lens';
import { rotatePoseY, shotPoseAt } from '../../lib/previz';

const deg2rad = THREE.MathUtils.degToRad;

/**
 * 机位可视化。
 * 选中镜头时，标记必须画在「视口相机实际所在的位姿」上（预演相机曲线），
 * 否则会看到盒子和机位取景画面完全对不上——之前它一直画的是左侧「机位」面板里的
 * 手动机位（默认 7.2 / 1.65m），和真正渲染用的预演机位是两套数据。
 */
export function CameraRig() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const showFrustum = useScene((s) => s.showFrustum);
  const followPreviz = useScene((s) => s.followPreviz);

  const rootRef = useRef<THREE.Group>(null);
  const aimRef = useRef<THREE.Group>(null);
  const poleRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  // 标签文字：只在焦距/高度变化到可见精度时更新，避免每帧触发 React 重渲染
  const [tag, setTag] = useState({ focal: Math.round(shot.focal), height: +shot.position[1].toFixed(1) });

  const lens = useMemo(() => lensMath(tag.focal, shot.sensor, shot.aspect), [tag.focal, shot.sensor, shot.aspect]);

  const frustum = useMemo(() => {
    const depth = 8;
    const hw = Math.tan(lens.hfov / 2) * depth;
    const hh = Math.tan(lens.vfov / 2) * depth;
    const corners: [number, number, number][] = [
      [-hw, -hh, -depth],
      [hw, -hh, -depth],
      [hw, hh, -depth],
      [-hw, hh, -depth],
    ];
    const points: number[] = [];
    for (const corner of corners) {
      points.push(0, 0, 0, ...corner);
    }
    for (let i = 0; i < 4; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      points.push(...a, ...b);
    }
    points.push(0, 0, 0, 0, 0, -depth);
    points.push(-hw, 0, -depth, hw, 0, -depth);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }, [lens.hfov, lens.vfov]);

  useEffect(() => () => frustum.dispose(), [frustum]);

  // 机位模型放 layer 1：主相机可见（已启用该层），机位取景画中画相机（layer 0）不可见。
  // 不分层的话，画中画相机正好套在机身盒里、镜头端盖贴在眼前 0.2m，整个小窗会被糊黑。
  useEffect(() => {
    rootRef.current?.traverse((o) => o.layers.set(1));
  });

  useFrame(() => {
    const root = rootRef.current;
    const aim = aimRef.current;
    if (!root || !aim) return;

    const st = useScene.getState();
    const live = st.activeShotId
      ? (st.previz?.shots.find((item) => item.id === st.activeShotId) ?? null)
      : null;
    // 与机位取景/跟随相机同一坐标系：叠加集合转向与摆放平移，否则标记与实际机位错位
    const raw = live ? shotPoseAt(live, st.timelineTime) : null;
    const pose = raw ? rotatePoseY(raw, st.ensembleYaw, st.setOffset) : null;

    const position = pose ? pose.position : st.camera.position;
    const yaw = pose ? pose.yaw : st.camera.yaw;
    const pitch = pose ? pose.pitch : st.camera.pitch;
    const roll = pose ? 0 : st.camera.roll;

    root.position.set(position[0], position[1], position[2]);
    aim.rotation.order = 'YXZ';
    aim.rotation.set(deg2rad(pitch), deg2rad(yaw), deg2rad(roll));

    const h = Math.max(0, position[1]);
    if (poleRef.current) {
      poleRef.current.scale.y = Math.max(0.001, h);
      poleRef.current.position.y = -h / 2;
      poleRef.current.visible = h > 0.05;
    }
    if (ringRef.current) ringRef.current.position.y = -h + 0.01;

    const focalText = Math.round(pose?.focal ?? st.camera.focal);
    const heightText = +h.toFixed(1);
    if (focalText !== tag.focal || heightText !== tag.height) {
      setTag({ focal: focalText, height: heightText });
    }
  });

  if (mode === 'camera' || followPreviz) return null;

  return (
    <group ref={rootRef} position={shot.position}>
      <group ref={aimRef}>
        <mesh castShadow>
          <boxGeometry args={[0.34, 0.28, 0.46]} />
          <meshStandardMaterial color="#ffb020" roughness={0.45} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0, -0.36]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.11, 0.13, 0.32, 18]} />
          <meshStandardMaterial color="#2b3542" roughness={0.5} metalness={0.4} />
        </mesh>
        {showFrustum && (
          <lineSegments geometry={frustum}>
            <lineBasicMaterial color="#ffb020" transparent opacity={0.55} />
          </lineSegments>
        )}
        <Html position={[0, 0.72, 0]} center distanceFactor={14} zIndexRange={[10, 0]}>
          <div className="camera-tag">
            {tag.focal}mm · {tag.height.toFixed(2)}m
          </div>
        </Html>
      </group>

      {/* 立杆与地面圆环：高度随机位实时变化，保证标记落在地面 */}
      <mesh ref={poleRef} position={[0, -shot.position[1] / 2, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 1, 6]} />
        <meshBasicMaterial color="#5b6b80" transparent opacity={0.7} />
      </mesh>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.35, 0.44, 32]} />
        <meshBasicMaterial color="#ffb020" transparent opacity={0.4} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
