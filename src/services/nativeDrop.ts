import { ref, shallowRef } from 'vue'
import type { Router } from 'vue-router'
import type { DragDropEvent } from '@tauri-apps/api/webview'

export const nativeDragging = ref(false)
export const nativeDropQueue = shallowRef<string[][]>([])

/** App owns the listener so drops over the sidebar and other pages also reach the library. */
export function handleNativeDragDrop(payload: DragDropEvent, router: Pick<Router, 'currentRoute' | 'push'>) {
  nativeDragging.value = payload.type === 'enter' || payload.type === 'over'
  if (payload.type !== 'drop' || !payload.paths.length) return
  nativeDropQueue.value = [...nativeDropQueue.value, [...payload.paths]]
  const path = router.currentRoute.value.path
  if (path !== '/library' && path !== '/papers') {
    void router.push('/library').catch(error => console.warn('[drop navigation]', error))
  }
}

/** Synchronous disposer also handles unmount while async registration is pending. */
export function startNativeDrop(router: Router, onError: (error: unknown) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
    getCurrentWebview().onDragDropEvent(event => {
      if (!disposed) handleNativeDragDrop(event.payload, router)
    }),
  ).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(onError)
  return () => { disposed = true; unlisten?.(); nativeDragging.value = false }
}
