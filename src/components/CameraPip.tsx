import { useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { pivotShift } from '../lib/previz';
import { useScene } from '../store/sceneStore';
import { resolveCameraView } from '../lib/cameraView';

const deg2rad = THREE.MathUtils.degToRad;

/**
 * 机位取景画中画的 3D 渲染器（必须在 <Canvas> 内）。
 * 以 render priority ≥ 1 接管渲染循环：先渲染主视口（自由视角），
 * 再对画中画小窗的矩形区域 setScissor 局部渲染机位专用相机；
 * 选中镜头无 3D 机位数据时跳过第二遍渲染，由小窗自己显示占位文字。
 */
export function PipRenderer({ winRef }: { winRef: RefObject<HTMLElement> }) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const mainCam = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  /** 机位专用相机：位姿与 FOV 每帧按共享解算结果驱动，不进场景图 */
  const pipCam = useMemo(() => new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 400), []);
  const lastBottom = useRef<number | null>(null);
  const lastWin = useRef<HTMLElement | null>(null);

  useFrame(() => {
    const st = useScene.getState();
    // 主视口：接管渲染循环后由这里负责整帧渲染（视口恢复到全屏）
    gl.setViewport(0, 0, size.width, size.height);
    gl.render(scene, mainCam);

    const win = winRef.current;
    if (!win) return;
    // 小窗元素随显隐/收起重新挂载：换元素时清掉 bottom 缓存，强制重写一次内联样式
    if (lastWin.current !== win) {
      lastWin.current = win;
      lastBottom.current = null;
    }

    // 收起态：小窗变成「机位取景 ▸」胶囊，仍按窗口同一规则叠放在 take 上方
    if (!st.camPipVisible) {
      if (win.classList.contains('cam-pip-reopen')) {
        const container = win.offsetParent as HTMLElement | null;
        const take = container?.querySelector<HTMLElement>('.take-player, .take-reopen') ?? null;
        let bottom = 14;
        if (take && container) {
          bottom = Math.max(14, container.clientHeight - take.offsetTop + 12);
        }
        if (lastBottom.current !== bottom) {
          win.style.bottom = `${bottom}px`;
          lastBottom.current = bottom;
        }
      }
      return;
    }

    // 叠放位置：take 小窗存在时贴其上方（间距 12px），否则贴视口右下角；放大态由 CSS inset 接管
    if (st.camPipEnlarged) {
      if (lastBottom.current !== null) {
        win.style.bottom = '';
        lastBottom.current = null;
      }
    } else {
      const container = win.offsetParent as HTMLElement | null;
      const take = container?.querySelector<HTMLElement>('.take-player, .take-reopen') ?? null;
      let bottom = 14;
      if (take && container) {
        bottom = Math.max(14, container.clientHeight - take.offsetTop + 12);
      }
      if (lastBottom.current !== bottom) {
        win.style.bottom = `${bottom}px`;
        lastBottom.current = bottom;
      }
    }

    // 无 3D 机位数据的镜头：不渲染 3D，小窗显示占位
    const activeShot = st.activeShotId
      ? (st.previz?.shots.find((s) => s.id === st.activeShotId) ?? null)
      : null;
    if (!activeShot) return;

    const canvas = gl.domElement;
    const base = canvas.getBoundingClientRect();
    const rect = win.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const view = resolveCameraView({
      cam: st.camera,
      activeShot,
      time: st.timelineTime,
      ensembleYaw: st.ensembleYaw,
      // 绕锚点转向：等效平移替代原始 setOffset
      setOffset: pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw),
      aspect: rect.width / rect.height,
      takeEl: st.takeVideoEl,
    });
    if (!view) return;
    pipCam.position.set(...view.position);
    pipCam.rotation.order = 'YXZ';
    pipCam.rotation.set(deg2rad(view.pitch), deg2rad(view.yaw), deg2rad(view.roll));
    pipCam.fov = view.fovDeg;
    pipCam.aspect = rect.width / rect.height;
    pipCam.updateProjectionMatrix();

    // 画中画矩形（相对主 canvas，WebGL 的 y 轴从底部起）
    const x = rect.left - base.left;
    const y = base.bottom - rect.bottom;
    gl.setScissorTest(true);
    gl.setViewport(x, y, rect.width, rect.height);
    gl.setScissor(x, y, rect.width, rect.height);
    gl.render(scene, pipCam);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.setScissor(0, 0, size.width, size.height);
  }, 1);

  return null;
}

/**
 * 机位取景画中画小窗：右下角覆盖层，风格与 take 小窗一致。
 * 有 3D 机位数据时窗口透明，露出底下 scissor 渲染的机位画面；
 * 无机位数据 / 未选镜头时显示居中占位文字。右上角按钮与双击均可放大/还原。
 */
export function CameraPipWindow({ winRef }: { winRef: RefObject<HTMLElement> }) {
  const visible = useScene((s) => s.camPipVisible);
  const toggleVisible = useScene((s) => s.toggleCamPip);
  const enlarged = useScene((s) => s.camPipEnlarged);
  const toggleEnlarged = useScene((s) => s.toggleCamPipEnlarged);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const noDataShot = useScene((s) => s.activeNoDataShot);

  // 收起态：与 take 小窗一致的「最小化胶囊」，点击恢复（ref 挂上供 PipRenderer 对齐叠放位置）
  if (!visible) {
    return (
      <button ref={winRef as RefObject<HTMLButtonElement>} className="cam-pip-reopen" onClick={toggleVisible} title="展开机位取景">
        机位取景 ▸
      </button>
    );
  }

  const hasRig = Boolean(activeShotId && previz?.shots.some((s) => s.id === activeShotId));
  const placeholder = hasRig ? null : noDataShot ? '该镜头无机位数据' : '未选择镜头';

  return (
    <section
      ref={winRef}
      className={`cam-pip ${hasRig ? 'live' : 'empty'} ${enlarged ? 'enlarged' : ''}`}
      onDoubleClick={toggleEnlarged}
      title={enlarged ? '双击还原' : '双击放大'}
    >
      <header className="cam-pip-head">
        <span className="cam-pip-title">机位取景</span>
        <span className="cam-pip-actions">
          <button
            className="cam-pip-toggle"
            onClick={(e) => {
              e.stopPropagation();
              toggleEnlarged();
            }}
          >
            {enlarged ? '还原' : '放大'}
          </button>
          <button
            className="cam-pip-hide"
            onClick={(e) => {
              e.stopPropagation();
              toggleVisible();
            }}
            title="最小化机位取景"
          >
            ✕
          </button>
        </span>
      </header>
      {placeholder && <div className="cam-pip-empty">{placeholder}</div>}
    </section>
  );
}
