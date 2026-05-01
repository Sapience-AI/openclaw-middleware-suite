/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { ComponentChildren } from 'preact';

interface GradientButtonProps {
  onClick?: () => void;
  children: ComponentChildren;
  type?: 'button' | 'submit';
  disabled?: boolean;
  small?: boolean;
  secondary?: boolean;
}

export function GradientButton({
  onClick,
  children,
  type = 'button',
  disabled,
  small,
  secondary,
}: GradientButtonProps) {
  const cls = [
    secondary ? 'btn-secondary' : 'btn-gradient',
    small && 'btn-sm',
  ].filter(Boolean).join(' ');

  return (
    <button class={cls} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
