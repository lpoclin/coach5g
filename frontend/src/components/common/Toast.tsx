import { createContext, useCallback, useContext, useReducer } from 'react'
import { IconX } from './icons'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

interface Toast {
  id: string
  kind: ToastKind
  message: string
}

type State = Toast[]
type Action =
  | { type: 'PUSH'; toast: Toast }
  | { type: 'POP'; id: string }

function reducer(state: State, action: Action): State {
  if (action.type === 'PUSH') return [...state, action.toast]
  return state.filter(t => t.id !== action.id)
}

interface ToastCtx {
  push: (kind: ToastKind, message: string, ttl?: number) => void
}

const Ctx = createContext<ToastCtx>({ push: () => {} })

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, dispatch] = useReducer(reducer, [])

  const push = useCallback((kind: ToastKind, message: string, ttl = 4_000) => {
    const id = `${Date.now()}-${Math.random()}`
    dispatch({ type: 'PUSH', toast: { id, kind, message } })
    setTimeout(() => dispatch({ type: 'POP', id }), ttl)
  }, [])

  const kindStyles: Record<ToastKind, string> = {
    info:    'border-blue-500/50 bg-blue-900/60 text-blue-200',
    success: 'border-green-500/50 bg-green-900/60 text-green-200',
    warn:    'border-yellow-500/50 bg-yellow-900/60 text-yellow-200',
    error:   'border-red-500/50 bg-red-900/60 text-red-200',
  }

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2 rounded border text-sm
                        backdrop-blur-sm animate-fade-in ${kindStyles[t.kind]}`}
          >
            <span className="flex-1 min-w-0 break-words">{t.message}</span>
            <button
              className="shrink-0 opacity-60 hover:opacity-100 mt-0.5"
              onClick={() => dispatch({ type: 'POP', id: t.id })}
            >
              <IconX className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  return useContext(Ctx)
}
