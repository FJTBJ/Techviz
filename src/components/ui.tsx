import type { ReactNode } from 'react';

export function Panel({
  title,
  extra,
  children,
}: {
  /** 无标题时省略 header（如工具面板用子 tab 行作首行） */
  title?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <header className="panel-head">
          <h2>{title}</h2>
          {extra}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function NumberField({
  label,
  value,
  step = 0.1,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-wrap">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isNaN(next)) onChange(next);
          }}
        />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field slider">
      <span>
        {label}
        <b className="mono">
          {value.toFixed(step < 1 ? 1 : 0)}
          {unit ?? ''}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
