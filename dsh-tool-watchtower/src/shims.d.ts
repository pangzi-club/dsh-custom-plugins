/**
 * Minimal ambient types for the browser half's platform imports.
 *
 * The plugin is built outside the repository workspace, so the real React and
 * primitives type packages are not resolvable from here; these declarations
 * cover exactly the surface `src/client/index.tsx` uses. They are build-time
 * only and never shipped in the bundle.
 */

declare module 'react' {
  export type ReactNode = any
  export type CSSProperties = Record<string, string | number | undefined>
  export type MutableRefObject<T> = { current: T }
  export function createElement(type: any, props?: any, ...children: any[]): any
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void) | undefined, deps?: readonly unknown[]): void
  export function useRef<T>(initial: T | null): MutableRefObject<T | null>
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T>(callback: T, deps: readonly unknown[]): T
  export const Fragment: any
}

declare module 'react-dom' {
  export function createPortal(children: any, container: any, key?: string | null): any
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function useAnchoredPosition(options: {
    open: boolean
    anchorRef: any
    panelRef: any
    side: 'top' | 'bottom'
    gap: number
    margin: number
  }): any
  export function useDismissOnOutsidePointer(
    rootRef: any,
    open: boolean,
    setOpen: (open: boolean) => void,
    panelRef?: any,
  ): void
  export function useAnchoredMaxHeight(ref: any, cap: number, signal: unknown): number
  export const Menu: any
  export const Modal: any
  export const Toast: any
  export const StateDot: any
}

declare namespace JSX {
  type Element = any
  interface IntrinsicElements { [name: string]: any }
}
