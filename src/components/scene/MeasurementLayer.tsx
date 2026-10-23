import { Html, Line } from '@react-three/drei';
import { useScene } from '../../store/sceneStore';

export function MeasurementLayer() {
  const measurements = useScene((s) => s.measurements);
  const pendingPoint = useScene((s) => s.pendingPoint);

  return (
    <group>
      {measurements.map((m) => {
        const mid: [number, number, number] = [
          (m.a[0] + m.b[0]) / 2,
          (m.a[1] + m.b[1]) / 2,
          (m.a[2] + m.b[2]) / 2,
        ];
        return (
          <group key={m.id}>
            <Line points={[m.a, m.b]} color="#3ddc97" lineWidth={2.5} />
            <mesh position={m.a}>
              <sphereGeometry args={[0.055, 10, 10]} />
              <meshBasicMaterial color="#3ddc97" />
            </mesh>
            <mesh position={m.b}>
              <sphereGeometry args={[0.055, 10, 10]} />
              <meshBasicMaterial color="#3ddc97" />
            </mesh>
            <Html position={mid} center distanceFactor={12} zIndexRange={[10, 0]}>
              <div className="measure-tag">
                {m.distance.toFixed(2)}m
                {m.deltaY > 0.001 && <span> · 高差 {m.deltaY.toFixed(2)}m</span>}
              </div>
            </Html>
          </group>
        );
      })}

      {pendingPoint && (
        <mesh position={pendingPoint}>
          <sphereGeometry args={[0.09, 14, 14]} />
          <meshBasicMaterial color="#3ddc97" />
        </mesh>
      )}
    </group>
  );
}
