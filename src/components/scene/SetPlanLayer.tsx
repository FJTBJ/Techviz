import { useMemo } from 'react';
import { Edges } from '@react-three/drei';
import { useScene } from '../../store/sceneStore';

const CATEGORY_COLOR: Record<string, string> = {
  platform: '#2f7fae',
  gapMask: '#8a5a2b',
  topSkirt: '#5d4a7a',
  backing: '#2f8a6f',
};

/** 布景方案层：把推导出的实体搭建条目画在环屏里，并标出预演机位 */
export function SetPlanLayer() {
  const plan = useScene((s) => s.setPlan);
  const scene = useScene((s) => s.planScene);
  const showSetPlan = useScene((s) => s.showSetPlan);
  const current = plan?.plans?.[scene ?? ''] ?? null;

  const cameraMarkers = useMemo(() => {
    if (!current) return [];
    const seen = new Set<string>();
    const out: { id: string; p: [number, number, number] }[] = [];
    for (const shot of current.shots) {
      if (!shot.camera) continue;
      const key = shot.camera.map((n) => n.toFixed(1)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: shot.id, p: shot.camera });
    }
    return out;
  }, [current]);

  if (!showSetPlan || !current) return null;

  return (
    <group>
      {current.setPieces.map((piece) => {
        const color = CATEGORY_COLOR[piece.category] ?? piece.color;
        return (
          <mesh
            key={piece.id}
            position={piece.position}
            rotation={[0, piece.rotationY, 0]}
            renderOrder={2}
          >
            <boxGeometry args={piece.size} />
            <meshStandardMaterial
              color={color}
              transparent
              opacity={0.4}
              roughness={0.75}
              metalness={0.05}
              depthWrite={false}
            />
            <Edges color={color} />
          </mesh>
        );
      })}

      {cameraMarkers.map((marker) => (
        <mesh key={marker.id} position={marker.p}>
          <octahedronGeometry args={[0.16, 0]} />
          <meshBasicMaterial color="#ffb020" />
        </mesh>
      ))}
    </group>
  );
}
