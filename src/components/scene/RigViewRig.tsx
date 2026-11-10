import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useScene } from '../../store/sceneStore';
import { pivotShift, rotatePoseY, shotPoseAt } from '../../lib/previz';

const ARM_L1 = 1.6;
const ARM_L2 = 1.6;
const ORANGE = '#fb923c';

/**
 * 第三视角设备视图：固定斜上方机位 + 程序化轨道机械臂。
 * 机械臂（轨道 / 滑块 / 立柱 / 两段臂 / 相机体）每帧 IK 跟随当前活跃机位，
 * 无预演数据时退回跟随主相机。启用时接管主相机到轨迹外斜上方，禁用时恢复进入前位姿。
 */
export function RigViewRig() {
  const on = useScene((s) => s.rigView);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const ensembleYaw = useScene((s) => s.ensembleYaw);
  const setOffset = useScene((s) => s.setOffset);
  const pivot = useScene((s) => s.ensemblePivot);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;
  const saved = useRef<{ pos: THREE.Vector3; fov: number; target: THREE.Vector3 } | null>(null);

  const shot = activeShotId
    ? (previz?.shots.find((s) => s.id === activeShotId) ?? null)
    : null;

  // 机位轨迹（世界坐标：叠加集合转向与摆放平移），用于轨道几何与第三视角落点
  const trail = useMemo(
    () =>
      shot
        ? shot.keys.map((k) => {
            const pose = rotatePoseY(
              { position: k.position, yaw: 0, pitch: 0, focal: null },
              ensembleYaw,
              pivotShift(setOffset, pivot, ensembleYaw),
            );
            return new THREE.Vector3(...pose.position);
          })
        : [],
    [shot, ensembleYaw, setOffset, pivot],
  );

  const rail = useMemo(() => {
    if (trail.length === 0) {
      return {
        centerX: 0,
        z: 0,
        len: 8,
        minX: -4,
        maxX: 4,
        center: new THREE.Vector3(0, 1, 0),
      };
    }
    const xs = trail.map((p) => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const zs = trail.map((p) => p.z).sort((a, b) => a - b);
    const z = zs[Math.floor(zs.length / 2)];
    const center = trail
      .reduce((acc, p) => acc.add(p), new THREE.Vector3())
      .divideScalar(trail.length);
    return {
      centerX: (minX + maxX) / 2,
      z,
      len: Math.max(2, maxX - minX + 2),
      minX: minX - 1,
      maxX: maxX + 1,
      center,
    };
  }, [trail]);

  const railRef = useRef(rail);
  useEffect(() => {
    railRef.current = rail;
  }, [rail]);

  // 启用：主相机移到轨迹中心外斜上方；禁用：恢复进入前位姿（俯视已接管相机时跳过）
  useEffect(() => {
    if (on) {
      saved.current = {
        pos: camera.position.clone(),
        fov: camera.fov,
        target: controls ? controls.target.clone() : new THREE.Vector3(),
      };
      const { center } = railRef.current;
      camera.position.set(center.x + 12, center.y + 10, center.z + 16);
      camera.fov = 48;
      camera.updateProjectionMatrix();
      camera.lookAt(center.x, 1, center.z);
      if (controls) {
        controls.target.set(center.x, 1, center.z);
        controls.update();
      }
      return;
    }
    const prev = saved.current;
    saved.current = null;
    if (!prev) return;
    if (useScene.getState().aerialView) return; // 俯视已接管相机，不要覆盖其机位
    camera.position.copy(prev.pos);
    camera.fov = prev.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(prev.target);
    if (controls) {
      controls.target.copy(prev.target);
      controls.update();
    }
  }, [on, camera, controls]);

  const sliderRef = useRef<THREE.Mesh>(null);
  const columnRef = useRef<THREE.Mesh>(null);
  const shoulderRef = useRef<THREE.Group>(null);
  const arm1PivotRef = useRef<THREE.Group>(null);
  const elbowPivotRef = useRef<THREE.Group>(null);
  const camBodyRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!on) return;
    const st = useScene.getState();
    // 目标位姿 = 当前活跃机位（世界坐标）；无预演数据时退回主相机
    const activeShot = st.activeShotId
      ? (st.previz?.shots.find((s) => s.id === st.activeShotId) ?? null)
      : null;
    const raw = activeShot ? shotPoseAt(activeShot, st.timelineTime) : null;
    const targetPos = new THREE.Vector3();
    const targetQuat = new THREE.Quaternion();
    if (raw) {
      const pose = rotatePoseY(
        raw,
        st.ensembleYaw,
        pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw),
      );
      targetPos.set(...pose.position);
      targetQuat.setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(pose.pitch),
          THREE.MathUtils.degToRad(pose.yaw),
          0,
          'YXZ',
        ),
      );
    } else {
      targetPos.copy(camera.position);
      targetQuat.copy(camera.quaternion);
    }

    const { z: railZ, minX, maxX } = railRef.current;
    const sx = THREE.MathUtils.clamp(targetPos.x, minX, maxX);
    const hBase = Math.max(0.4, targetPos.y - 2.6);

    if (sliderRef.current) sliderRef.current.position.set(sx, 0.27, railZ);
    if (columnRef.current) {
      const h = Math.max(0.05, hBase - 0.42);
      columnRef.current.position.set(sx, 0.42 + h / 2, railZ);
      columnRef.current.scale.y = h;
    }

    // 两骨 IK：肩关节组先转到朝向目标的竖直平面，平面内按余弦定理求肩/肘角（肘朝上）
    const shoulder = shoulderRef.current;
    const arm1 = arm1PivotRef.current;
    const elbow = elbowPivotRef.current;
    if (shoulder && arm1 && elbow) {
      shoulder.position.set(sx, hBase, railZ);
      const dx = targetPos.x - sx;
      const dy = targetPos.y - hBase;
      const dz = targetPos.z - railZ;
      shoulder.rotation.y = Math.atan2(dx, dz);
      const hDist = Math.max(1e-4, Math.hypot(dx, dz));
      const d = THREE.MathUtils.clamp(Math.hypot(dy, hDist), 0.2, ARM_L1 + ARM_L2 - 0.01);
      const baseAng = Math.atan2(dy, hDist);
      const cosShoulder = THREE.MathUtils.clamp(
        (ARM_L1 * ARM_L1 + d * d - ARM_L2 * ARM_L2) / (2 * ARM_L1 * d),
        -1,
        1,
      );
      const cosElbow = THREE.MathUtils.clamp(
        (ARM_L1 * ARM_L1 + ARM_L2 * ARM_L2 - d * d) / (2 * ARM_L1 * ARM_L2),
        -1,
        1,
      );
      arm1.rotation.x = -(baseAng + Math.acos(cosShoulder));
      elbow.rotation.x = Math.PI - Math.acos(cosElbow);
    }

    if (camBodyRef.current) {
      camBodyRef.current.position.copy(targetPos);
      camBodyRef.current.quaternion.copy(targetQuat);
    }
  });

  if (!on) return null;

  const { centerX, z: railZ, len } = rail;

  return (
    <group>
      {/* 轨道 */}
      <mesh position={[centerX, 0.06, railZ]}>
        <boxGeometry args={[len, 0.12, 0.25]} />
        <meshStandardMaterial color={ORANGE} roughness={0.6} />
      </mesh>
      {/* 滑块 */}
      <mesh ref={sliderRef} position={[centerX, 0.27, railZ]}>
        <boxGeometry args={[0.4, 0.3, 0.4]} />
        <meshStandardMaterial color="#9ca3af" roughness={0.5} />
      </mesh>
      {/* 立柱（单位高度圆柱，scale.y 每帧跟随相机高度） */}
      <mesh ref={columnRef} position={[centerX, 0.5, railZ]}>
        <cylinderGeometry args={[0.06, 0.06, 1, 12]} />
        <meshStandardMaterial color="#9ca3af" roughness={0.5} />
      </mesh>
      {/* 肩关节 + 两段臂（l1 / 肘球 / l2） */}
      <group ref={shoulderRef} position={[centerX, 1.6, railZ]}>
        <mesh>
          <sphereGeometry args={[0.12, 16, 16]} />
          <meshStandardMaterial color={ORANGE} roughness={0.45} />
        </mesh>
        <group ref={arm1PivotRef}>
          <mesh position={[0, 0, ARM_L1 / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.07, 0.07, ARM_L1, 12]} />
            <meshStandardMaterial color={ORANGE} roughness={0.55} />
          </mesh>
          <group position={[0, 0, ARM_L1]}>
            <mesh>
              <sphereGeometry args={[0.12, 16, 16]} />
              <meshStandardMaterial color={ORANGE} roughness={0.45} />
            </mesh>
            <group ref={elbowPivotRef}>
              <mesh position={[0, 0, ARM_L2 / 2]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.07, 0.07, ARM_L2, 12]} />
                <meshStandardMaterial color={ORANGE} roughness={0.55} />
              </mesh>
            </group>
          </group>
        </group>
      </group>
      {/* 相机体（贴在当前机位位姿上） */}
      <group ref={camBodyRef}>
        <mesh>
          <boxGeometry args={[0.3, 0.3, 0.45]} />
          <meshStandardMaterial color="#e5e7eb" roughness={0.4} />
        </mesh>
      </group>
    </group>
  );
}
