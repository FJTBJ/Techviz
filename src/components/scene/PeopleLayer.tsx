import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useScene } from '../../store/sceneStore';
import { apiFetch } from '../../lib/api';
import { buildWalkableSurfaces, groundHeightAt } from '../../lib/previz';
import type { WalkableSurface } from '../../lib/previz';
import { AnimatedActor } from './AnimatedActor';
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

/** 通用骨架 json（MetaHuman 骨架层级相同，仅作体型结构；后续角色动画导出后逐角色替换） */
const GENERIC_RIG_URL = '/models/s079a/nuola_rig.json';

/** MetaHuman 编号惯例：F=女 M=男，据此给不同角色区分身高 */
const personHeight = (label: string) => (/f\d/i.test(label) ? 1.65 : /m\d/i.test(label) ? 1.78 : 1.72);

/** 单个演员：人形代理 + 名称牌，位置每帧按时间线推进；走位点落在可踩台面上时抬升到台面顶面 */
function PersonActor({ person, index, offset, shotStart, surfaces }: {
  person: UePerson;
  index: number;
  offset: number;
  shotStart: number;
  surfaces: WalkableSurface[];
}) {
  const group = useRef<THREE.Group>(null);
  const color = PALETTE[index % PALETTE.length];

  // 初始位置：take 起始时间（含台面抬升）
  const initial = useMemo(() => {
    const base = sampleKeys(person.keys, offset) ?? { p: [0, 0, 0] as [number, number, number], yaw: 0 };
    return {
      p: [
        base.p[0],
        Math.max(base.p[1], groundHeightAt(base.p[0], base.p[2], surfaces)),
        base.p[2],
      ] as [number, number, number],
      yaw: base.yaw,
    };
  }, [person, offset, surfaces]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const t = useScene.getState().timelineTime - shotStart + offset;
    const pose = sampleKeys(person.keys, t);
    if (!pose) return;
    // 站立海拔：走位数据自带 y 与可踩台面顶面取高者，避免穿入台面
    const gy = groundHeightAt(pose.p[0], pose.p[2], surfaces);
    g.position.set(pose.p[0], Math.max(pose.p[1], gy), pose.p[2]);
    g.rotation.y = THREE.MathUtils.degToRad(pose.yaw);
  });

  return (
    <group ref={group} position={initial.p}>
      {/* json 骨架人形（静态姿态），整体位移与朝向由走位轨迹驱动 */}
      <AnimatedActor
        animUrl={GENERIC_RIG_URL}
        mode="rest"
        height={personHeight(person.label)}
        clothColor={color}
      />
    </group>
  );
}

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

  // 可踩台面（UE 抬高地坪 + 方案地台）：演员走位落到其上时抬升到台面顶面
  const assets = useScene((s) => s.assets);
  const surfaces = useMemo(() => buildWalkableSurfaces(assets), [assets]);

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
          surfaces={surfaces}
        />
      ))}
    </group>
  );
}
