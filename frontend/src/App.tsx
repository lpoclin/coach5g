import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/common/Toast'
import Layout from '@/components/common/Layout'
import TopologyPage from '@/pages/TopologyPage'
import InfrastructurePage from '@/pages/InfrastructurePage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 2_000,
    },
  },
})

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true,            element: <TopologyPage /> },
      { path: 'infrastructure', element: <InfrastructurePage /> },
      { path: 'captures',       element: <></> },  // Layout always mounts CapturePage
    ],
  },
])

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  )
}
