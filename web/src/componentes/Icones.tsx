// Ícones de navegação em SVG inline, todos no mesmo traço (stroke, sem preenchimento,
// pontas arredondadas) usado no sino de Avisos.tsx e no globo de Bandeira.tsx.

type Props = { size?: number };

const base = { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconeInicio({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9h12v-9" />
    </svg>
  );
}

export function IconeCandidatos({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c0-3.6 3-6.2 7-6.2s7 2.6 7 6.2" />
    </svg>
  );
}

export function IconeMapa({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </svg>
  );
}

export function IconeNovidades({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M5 5h11a3 3 0 0 1 3 3v8.5a2.5 2.5 0 0 1-4.2 1.85L13 16.5H8a3 3 0 0 1-3-3V5Z" />
      <path d="M8.5 9.2h7M8.5 12h4.5" />
    </svg>
  );
}

export function IconeMais({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconePresidente({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4 18 6 7l6 4 6-4 2 11" />
      <path d="M4 18h16" />
    </svg>
  );
}

export function IconeGovernador({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4 20V10l8-5 8 5v10" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

export function IconeSenador({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M12 3v3M6 10a6 6 0 0 1 12 0v8H6z" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function IconeDeputado({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="4" y="5" width="16" height="13" rx="1.5" />
      <path d="M4 10h16M9 5v13" />
    </svg>
  );
}

export function IconePorEstado({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </svg>
  );
}

export function IconeSobre({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 8v.1" />
    </svg>
  );
}

export function IconeCompartilhar({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="18" cy="6" r="2.4" /><circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="18" r="2.4" />
      <path d="m8.1 10.8 7.8-3.6M8.1 13.2l7.8 3.6" />
    </svg>
  );
}

export function IconeMetodologia({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 12h6M9 15.5h6M9 8.5h3" />
    </svg>
  );
}

export function IconeLink({ size = 20 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M10 14 19 5" />
      <path d="M13 5h6v6M19 13v6H5V5h6" />
    </svg>
  );
}

export function IconeRelogio({ size = 14 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  );
}

export function IconeFonte({ size = 14 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M12 3c4 0 7 1.3 7 3s-3 3-7 3-7-1.3-7-3 3-3 7-3Z" />
      <path d="M5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3" />
    </svg>
  );
}

export function IconePainel({ size = 18 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M10 4v16" />
    </svg>
  );
}

export function IconeVoltar({ size = 18 }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M14 5 7 12l7 7" />
    </svg>
  );
}
