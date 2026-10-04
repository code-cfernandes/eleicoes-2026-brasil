// Bandeira de UF (decorativa: o nome por extenso já está ao lado). Exterior (zz) não tem
// bandeira própria: usa um globo em SVG no mesmo traço do ícone de sino de Avisos.tsx.
function Globo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="bandeira bandeira-globo">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 4 6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-6-4-9s1.5-6.4 4-9Z" />
    </svg>
  );
}

export function Bandeira({ uf }: { uf: string }) {
  if (uf === 'zz') return <Globo />;
  return <img className="bandeira" src={`/bandeiras/${uf}.png`} alt="" width={36} height={24} loading="lazy" decoding="async" />;
}
