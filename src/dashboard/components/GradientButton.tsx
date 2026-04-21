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
