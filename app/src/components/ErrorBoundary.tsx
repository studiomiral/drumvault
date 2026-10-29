import { Component, type ReactNode } from 'react'
import { Button } from './ui'

/** A page that throws while rendering shows what went wrong instead of an empty window. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
        <div className="text-text font-medium">This page ran into an error</div>
        <pre className="max-w-[640px] whitespace-pre-wrap text-[12px] text-bad select-text">{error.message}</pre>
        <Button onClick={() => this.setState({ error: null })}>Try again</Button>
      </div>
    )
  }
}
