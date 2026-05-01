/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { useRef, useEffect } from 'preact/hooks';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface ChartProps {
  title?: string;
  data: uPlot.AlignedData;
  options?: Partial<uPlot.Options>;
  height?: number;
}

export function Chart({ title, data, options, height = 200 }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const width = containerRef.current.clientWidth;

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    if (data[0].length === 0) return;

    const defaultOpts: uPlot.Options = {
      width,
      height,
      cursor: { show: true },
      legend: { show: true },
      scales: {
        x: { time: true },
      },
      axes: [
        {
          stroke: '#64605e',
          grid: { stroke: 'rgba(196, 181, 208, 0.15)' },
          ticks: { stroke: 'rgba(196, 181, 208, 0.15)' },
          font: '12px Inter',
        },
        {
          stroke: '#64605e',
          grid: { stroke: 'rgba(196, 181, 208, 0.15)' },
          ticks: { stroke: 'rgba(196, 181, 208, 0.15)' },
          font: '12px Inter',
        },
      ],
      series: [
        {},
        {
          stroke: '#674C67',
          fill: 'rgba(103, 76, 103, 0.08)',
          width: 2,
          label: 'Value',
        },
      ],
      ...options,
    };

    chartRef.current = new uPlot(defaultOpts, data, containerRef.current);

    const observer = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.setSize({
          width: containerRef.current.clientWidth,
          height,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chartRef.current?.destroy();
    };
  }, [data, height]);

  return (
    <div class="chart-wrap">
      {title && <div class="chart-title">{title}</div>}
      <div class="chart-container" ref={containerRef}>
        {data[0].length === 0 && (
          <div class="chart-empty">No data available</div>
        )}
      </div>
    </div>
  );
}
