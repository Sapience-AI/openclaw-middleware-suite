/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Round amber "i" icon for caveats next to labels — used wherever a UI
 * surface needs to flag a soft warning ("this might trigger a restart",
 * "this counter only includes routed calls", etc.) without escalating to
 * a full pill or banner. Color matches `--sai-warning` so it reads as part
 * of the same family as the Model Routing "Restarts gateway" pill on
 * the Overview page.
 */

interface WarningInfoIconProps {
  /** Hover tooltip text. Required — if there's nothing to explain there's
   *  no reason to draw the icon. */
  tooltip: string;
  /** Optional override for accessibility label. Defaults to `tooltip`. */
  ariaLabel?: string;
}

export function WarningInfoIcon({ tooltip, ariaLabel }: WarningInfoIconProps) {
  return (
    <span
      title={tooltip}
      aria-label={ariaLabel ?? tooltip}
      role="img"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'help',
        color: 'var(--sai-warning)',
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.45)',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        fontSize: '10px',
        fontWeight: 700,
        fontStyle: 'italic',
        fontFamily: 'Georgia, serif',
        lineHeight: '1',
        flexShrink: 0,
        userSelect: 'none',
        textTransform: 'none',
      }}
    >
      i
    </span>
  );
}
