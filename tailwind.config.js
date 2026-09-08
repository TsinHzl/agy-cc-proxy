/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./public/**/*.{html,js}"  // Simplified: already covers all subdirectories
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'Consolas', 'monospace'],
        sans: ['"IBM Plex Sans"', '"PingFang SC"', '"Hiragino Sans GB"', 'system-ui', 'sans-serif']
      },
      colors: {
        /* ===== shadcn HSL 三元组轨道（支持 bg-primary/50 透明度修饰符） ===== */
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        /* ===== kiro2cc 语义色轨道（整值 var() 引用，不支持 /50 修饰符 ——
           需半透明时一律用 -soft / -line 变体，.dark 下已是 rgba） ===== */
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)'
        },
        sidebar: 'var(--sidebar)',
        hairline: {
          DEFAULT: 'var(--hairline)',
          2: 'var(--hairline-2)'
        },
        ink: {
          DEFAULT: 'var(--ink)',
          2: 'var(--ink-2)',
          3: 'var(--ink-3)'
        },
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          deep: 'var(--brand-deep)',
          fg: 'var(--brand-fg)',
          soft: 'var(--brand-soft)',
          line: 'var(--brand-line)'
        },
        ok: {
          DEFAULT: 'var(--ok)',
          soft: 'var(--ok-soft)',
          line: 'var(--ok-line)'
        },
        warn: {
          DEFAULT: 'var(--warn)',
          soft: 'var(--warn-soft)',
          line: 'var(--warn-line)'
        },
        danger: {
          DEFAULT: 'var(--danger)',
          soft: 'var(--danger-soft)',
          line: 'var(--danger-line)'
        },
        track: 'var(--track)',
        'code-bg': 'var(--code-bg)',
        /* ===== 旧主题色组（保留：HTML/JS 仍有引用，霓虹值已由 input.css 保名换值语义接管；
              此处整值 hex 仅为 purge 兜底，实际渲染走 CSS 变量。
              注意：本组 hex 与 public/css/src/input.css :root/.dark 中同名 CSS 变量
              双处维护，改色时必须两处同步） ===== */
        space: {
          950: '#1B2226',
          900: '#F1F2F4',
          850: '#FAFAFB',
          800: '#F1F2F4',
          border: '#E6E8EA'
        },
        neon: {
          purple: '#0D7A6F',
          cyan: '#0D7A6F',
          green: '#137A4C',
          yellow: '#9A6300',
          red: '#BB3538'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      boxShadow: {
        hair: 'var(--shadow-sm)',
        panel: 'var(--shadow-md)',
        pop: 'var(--shadow-pop)'
      }
    }
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('daisyui')
  ],
  daisyui: {
    themes: [{
      antigravity: {
        "primary": "#0D7A6F",      // brand
        "secondary": "#5F646B",    // ink-2
        "accent": "#2BB8A6",       // brand（暗色主值）
        "neutral": "#1B2226",      // 深色 tooltip 语义值
        "base-100": "#F6F7F8",     // 背景
        "base-200": "#FAFAFB",     // surface-2
        "base-300": "#E6E8EA",     // hairline
        "info": "#0284c7",         // quota-mod 渐变首色
        "success": "#137A4C",      // ok
        "warning": "#9A6300",      // warn
        "error": "#BB3538",        // danger
      }
    }],
    logs: false  // Disable console logs in production
  }
}
