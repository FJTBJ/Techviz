import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useScene } from '../../store/sceneStore';
import { lensMath } from '../../lib/lens';

const deg2rad = THREE.MathUtils.degToRad;

export function CameraRig() {
  const shot = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const showFrustum = useScene((s) => s.showFrustum);
  const followPreviz = useScene((s) => s.followPreviz);

  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);

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
    // 画面中心线与水平中线
    points.push(0, 0, 0, 0, 0, -depth);
    points.push(-hw, 0, -depth, hw, 0, -depth);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }, [lens.hfov, lens.vfov]);

  useEffect(() => () => frustum.dispose(), [frustum]);

  const poleGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, -shot.position[1], 0], 3),
    );
    return geometry;
  }, [shot.position]);

  useEffect(() => () => poleGeometry.dispose(), [poleGeometry]);

  if (mode === 'camera' || followPreviz) return null;

  return (
    <group position={shot.position}>
      <group rotation={[deg2rad(shot.pitch), deg2rad(shot.yaw), deg2rad(shot.roll)]} rotation-order="YXZ">
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
            {shot.focal}mm · {shot.position[1].toFixed(2)}m
          </div>
        </Html>
      </group>

      {shot.position[1] > 0.05 && (
        <lineSegments geometry={poleGeometry}>
          <lineBasicMaterial color="#5b6b80" transparent opacity={0.7} />
        </lineSegments>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -shot.position[1] + 0.01, 0]}>
        <ringGeometry args={[0.35, 0.44, 32]} />
        <meshBasicMaterial color="#ffb020" transparent opacity={0.4} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
