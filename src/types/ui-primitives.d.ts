/**
 * Local types for @deepseek-ai/dsh-client-ui-primitives.
 *
 * The package ships with the harness client and is not a dependency of this
 * plugin. Declaring the few primitives this UI imports keeps the client half
 * type-checked against React's own element props instead of silently falling
 * back to `any`. Anything not declared here is not used here.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  type ReactButtonProps = import('react').ButtonHTMLAttributes<HTMLButtonElement>
  type ReactNode = import('react').ReactNode
  type FC<P> = import('react').FunctionComponent<P>

  export interface ButtonProps extends ReactButtonProps {
    /** Primitive size step; the plugin only uses 'sm'. */
    size?: 'sm' | 'md' | 'lg'
    variant?: string
  }

  export interface IconProps {
    size?: number
    className?: string
  }

  export interface TooltipProps {
    label?: ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
    portal?: boolean
    children?: ReactNode
  }

  export interface ModalProps {
    open?: boolean
    onClose?: () => void
    className?: string
    children?: ReactNode
  }

  export const Button: FC<ButtonProps>
  export const Modal: FC<ModalProps>
  export const Tooltip: FC<TooltipProps>
  export const IconCloseOutlineRegular: FC<IconProps>
  export const IconMicrophoneOutlineRegular: FC<IconProps>
  export const IconSettingsOutlineRegular: FC<IconProps>
  export const IconStopFillRegular: FC<IconProps>
}
