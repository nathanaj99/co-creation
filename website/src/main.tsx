// import { StrictMode } from 'react'
// import { createRoot } from 'react-dom/client'
// import './index.css'
// import App from './App.tsx'

// import React from 'react'
// import ReactDOM from 'react-dom/client'
// import App from './App.tsx'
// import './index.css' // <-- keep this
// ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

// createRoot(document.getElementById('root')!).render(
//   <StrictMode>
//     <App />
//   </StrictMode>,
// )


import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import AppTask2 from './AppTask2.tsx'
import './index.css'

const task = new URLSearchParams(window.location.search).get('task')
const Root = task === '2' ? AppTask2 : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)