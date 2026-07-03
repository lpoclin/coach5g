/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark telecom theme
        bg: {
          primary: '#0a0e1a',
          secondary: '#0f1629',
          tertiary: '#131d35',
          card: '#151e35',
          hover: '#1a2540',
        },
        border: {
          DEFAULT: '#1e2d4a',
          hover: '#2a3f6a',
        },
        // Plane colors
        sbi: {
          DEFAULT: '#3b82f6', // blue-500
          dim: '#1d4ed8',
          glow: '#60a5fa',
        },
        userplane: {
          DEFAULT: '#22c55e', // green-500
          dim: '#15803d',
          glow: '#4ade80',
        },
        ran: {
          DEFAULT: '#f97316', // orange-500
          dim: '#c2410c',
          glow: '#fb923c',
        },
        pfcp: {
          DEFAULT: '#a855f7', // purple-500
          dim: '#7e22ce',
          glow: '#c084fc',
        },
        // Status colors
        status: {
          ok: '#22c55e',
          warn: '#eab308',
          error: '#ef4444',
          unknown: '#6b7280',
        },
        // Protocol colors (packet capture)
        proto: {
          gtpu: '#22c55e',
          pfcp: '#3b82f6',
          http2: '#a855f7',
          sctp: '#f97316',
          nas: '#eab308',
          dns: '#14b8a6',
          other: '#6b7280',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'ui-monospace', 'monospace'],
      },
      animation: {
        'flow': 'flow 2s linear infinite',
        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in-right': 'slideInRight 0.2s ease-out',
        'fade-in': 'fadeIn 0.15s ease-out',
      },
      keyframes: {
        flow: {
          '0%': { 'stroke-dashoffset': '20' },
          '100%': { 'stroke-dashoffset': '0' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
