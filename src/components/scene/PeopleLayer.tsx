import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useScene } from '../../store/sceneStore';
import { apiFetch } from '../../lib/api';
import type { PrevizShot, UePeople, UePerson, UePersonKey } from '../../types';

/** 在关键帧之间线性插值（yaw 走最短弧） */
function sampleKeys(keys: UePersonKey[], s: number): { p: [number, number, number]; yaw: number } | null {
  if (!keys.length) return null;
  if (keys.length === 1 || s <= keys[0].s) return { p: [...keys[0].p], yaw: keys[0].yaw };
  const last = keys[keys.length - 1];
  if (s >= last.s) return { p: [...last.p], yaw: last.yaw };
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.s - a.s;
  const f = span > 1e-6 ? (s - a.s) / span : 0;
  let dyaw = b.yaw - a.yaw;
  if (dyaw > 180) dyaw -= 360;
  if (dyaw < -180) dyaw += 360;
  return {
    p: [
      a.p[0] + (b.p[0] - a.p[0]) * f,
      a.p[1] + (b.p[1] - a.p[1]) * f,
      a.p[2] + (b.p[2] - a.p[2]) * f,
    ],
    yaw: a.yaw + dyaw * f,
  };
}

const PALETTE = ['#4a86c8', '#c8794a', '#4fa87a', '#b5647f', '#8a6fc0', '#b39a45'];
const SKIN = '#e0b08c';

/** 简易人形代理：头 / 躯干 / 双臂 / 双腿，脚底在原点，身高约 1.72m */
function Humanoid({ color }: { color: string }) {
  const cloth = <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />;
  const skin = <meshStandardMaterial color={SKIN} roughness={0.85} metalness={0} />;
  return (
    <group>
      {/* 双腿 */}
      <mesh position={[-0.09, 0.44, 0]} castShadow>
        <capsuleGeometry args={[0.075, 0.6, 4, 10]} />
        <meshStandardMaterial color="#33404f" roughness={0.75} />
      </mesh>
      <mesh position={[0.09, 0.44, 0]} castShadow>
        <capsuleGeometry args={[0.075, 0.6, 4, 10]} />
        <meshStandardMaterial color="#33404f" roughness={0.75} />
      </mesh>
      {/* 胯与躯干 */}
      <mesh position={[0, 0.88, 0]} castShadow>
        <capsuleGeometry args={[0.145, 0.1, 4, 12]} />
        {cloth}
      </mesh>
      <mesh position={[0, 1.2, 0]} castShadow>
        <capsuleGeometry args={[0.17, 0.34, 6, 14]} />
        {cloth}
      </mesh>
      {/* 双臂 */}
      <mesh position={[-0.245, 1.18, 0]} rotation={[0, 0, 0.09]} castShadow>
        <capsuleGeometry args={[0.052, 0.46, 4, 8]} />
        {cloth}
      </mesh>
      <mesh position={[0.245, 1.18, 0]} rotation={[0, 0, -0.09]} castShadow>
        <capsuleGeometry args={[0.052, 0.46, 4, 8]} />
        {cloth}
      </mesh>
      {/* 手 */}
      <mesh position={[-0.25, 0.92, 0]}>
        <sphereGeometry args={[0.05, 12, 10]} />
        {skin}
      </mesh>
      <mesh position={[0.25, 0.92, 0]}>
        <sphereGeometry args={[0.05, 12, 10]} />
        {skin}
      </mesh>
      {/* 颈与头 */}
      <mesh position={[0, 1.45, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.08, 8]} />
        {skin}
      </mesh>
      <mesh position={[0, 1.58, 0]} castShadow>
        <sphereGeometry args={[0.105, 18, 14]} />
        {skin}
      </mesh>
      {/* 头发：让头部轮廓更像人 */}
      <mesh position={[0, 1.585, 0.005]} castShadow>
        <sphereGeometry args={[0.112, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
        <meshStandardMaterial color="#2b211c" roughness={0.95} />
      </mesh>
      {/* 鼻子：标记朝向（yaw 0 朝 -Z） */}
      <mesh position={[0, 1.575, -0.1]}>
        <sphereGeometry args={[0.032, 8, 8]} />
        {skin}
      </mesh>
    </group>
  );
}

/** 单个演员：人形代理 + 名称牌，位置每帧按时间线推进 */
function PersonActor({ person, index, offset, shotStart }: {
  person: UePerson;
  index: number;
  offset: number;
  shotStart: number;
}) {
  const group = useRef<THREE.Group>(null);
  const color = PALETTE[index % PALETTE.length];

  // 初始位置：take 起始时间
  const initial = useMemo(() => sampleKeys(person.keys, offset) ?? { p: [0, 0, 0] as [number, number, number], yaw: 0 }, [person, offset]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const t = useScene.getState().timelineTime - shotStart + offset;
    const pose = sampleKeys(person.keys, t);
    if (!pose) return;
    g.position.set(pose.p[0], pose.p[1], pose.p[2]);
    g.rotation.y = THREE.MathUtils.degToRad(pose.yaw);
  });

  return (
    <group ref={group} position={initial.p}>
      <Humanoid color={color} />
      <Html position={[0, 1.95, 0]} center distanceFactor={16} zIndexRange={[8, 0]}>
        <div className="person-tag" style={{ borderColor: color }}>
          <b>{displayLabel(person)}</b>
        </div>
      </Html>
    </group>
  );
}

/** 展示名去掉 UE 资产前缀，只留角色代号与姓名 */
const displayLabel = (person: UePerson) =>
  person.label.replace(/^(Char_|FIX\s*)/i, '').trim() || person.label;

/** 同一演员在 UE 里可能被重复引用（Char_ / FIX 两份、名字多一个 2），按轨迹去重 */
const trackSignature = (person: UePerson) => {
  const keys = person.keys;
  if (!keys.length) return '';
  const first = keys[0].p.join(',');
  const last = keys[keys.length - 1].p.join(',');
  return `${keys.length}|${first}|${last}`;
};

/** 同名轨迹优先保留 Char_ 前缀、命名更干净的一条 */
const keepScore = (person: UePerson) =>
  (/^char/i.test(person.name) ? 2 : 0) + (/^char_[a-z0-9]+\s/i.test(person.name) ? 1 : 0);

/**
 * 镜头人物层：读取 UE take 对应 PostData 镜头序列里的人物动画，
 * 仅在选中镜头时显示，时间线播放/拖动时同步位移。
 */
export function PeopleLayer({ shot }: { shot: PrevizShot | null }) {
  const [people, setPeople] = useState<UePeople | null>(null);
  const shotName = shot?.name ?? null;

  useEffect(() => {
    if (!shotName) {
      setPeople(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/ue-people?shot=${encodeURIComponent(shotName)}`)
      .then(async (res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled) return;
        setPeople(payload?.code === 0 ? (payload.data as UePeople) : null);
      })
      .catch(() => {
        if (!cancelled) setPeople(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shotName]);

  const info = shotName && people ? people.shots[shotName] : null;

  // 同一演员可能被重复引用，轨迹完全相同时合并成一个人，避免人形重叠、观感怪异
  const characters = useMemo(() => {
    const list = info?.characters ?? [];
    const picked = new Map<string, UePerson>();
    for (const person of list) {
      const sig = trackSignature(person);
      if (!sig) continue;
      const prev = picked.get(sig);
      if (!prev || keepScore(person) > keepScore(prev)) picked.set(sig, person);
    }
    return [...picked.values()];
  }, [info]);

  if (!shot || !info || !characters.length) return null;

  return (
    <group>
      {characters.map((person, index) => (
        <PersonActor
          key={person.name}
          person={person}
          index={index}
          offset={info.offset}
          shotStart={shot.start}
        />
      ))}
    </group>
  );
}
