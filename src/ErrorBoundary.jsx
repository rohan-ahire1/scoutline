import React from 'react'
import { CircleAlert, Home, RefreshCcw } from 'lucide-react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) { return { error } }

  componentDidCatch(error, info) {
    console.error('Scoutline render failure', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="fatal-error" role="alert">
      <div className="state-icon state-icon-error"><CircleAlert size={20} /></div>
      <span>Unexpected interface error</span>
      <h1>This view could not be displayed.</h1>
      <p>Your saved client data is unaffected. Reload the interface, or return to Clients if this route keeps failing.</p>
      <div>
        <button className="button button-secondary" onClick={() => window.location.assign('/clients')}><Home size={13} />Go to clients</button>
        <button className="button button-primary" onClick={() => window.location.reload()}><RefreshCcw size={13} />Reload app</button>
      </div>
      <details><summary>Technical detail</summary><code>{this.state.error.message || 'Unknown render error'}</code></details>
    </main>
  }
}
