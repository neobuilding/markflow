import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { queryClient } from './lib/queryClient'
import { warmupParseWorker } from './lib/parseClient'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)

// Warm up the parse Worker (shiki cold-start cost etc.) so the preview doesn't stall on first document open.
warmupParseWorker()
