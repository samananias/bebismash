export function PixelArt({ scene = 0 }: { scene?: number }) {
  return (
    <svg
      viewBox="0 0 240 128"
      role="img"
      aria-label={
        ['Pixel mountain landscape', 'Pixel woodland cabin', 'Pixel seaside sunset'][scene % 3]
      }
      shapeRendering="crispEdges"
    >
      <rect width="240" height="128" fill={['#b1d8c6', '#c4b7d2', '#f4bb91'][scene % 3]} />
      <path d="M0 16h40v8h24v8H0zm146 0h38v8h22v8h-60" fill="#fff1d2" />
      <rect x={scene === 2 ? 156 : 178} y="28" width="24" height="24" fill="#ffa43a" />
      {scene === 0 ? (
        <>
          <path d="M0 92h16V76h16V60h16V44h16V28h16v16h16v16h16v16h16v16h16v36H0" fill="#557979" />
          <path
            d="M88 128V96h16V80h16V64h16V48h16V32h16v16h16v16h16v16h16v16h24v32"
            fill="#324d55"
          />
          <path d="M48 44h16V28h16v16h16v16H80V48H64v12H48" fill="#fff1d2" />
        </>
      ) : scene === 1 ? (
        <>
          <path d="M0 78h240v50H0" fill="#70866a" />
          <path
            d="M24 92V64H14V54h10V34h10v20h10v10H34v28m162 2V50h-10V40h10V20h10v20h10v10h-10v44"
            fill="#335a49"
          />
          <path d="M80 84h16V68h16V52h24v16h16v16h16v44H80" fill="#754f4c" />
          <path d="M88 84h16V68h16V52h8v16h16v16h16" fill="none" stroke="#f8dab0" strokeWidth="8" />
          <path d="M116 100h16v28h-16m24-36h12v12h-12" fill="#f7c86b" />
        </>
      ) : (
        <>
          <path d="M0 66h240v62H0" fill="#588c99" />
          <path d="M144 70h44v6h-44m-16 8h76v6h-76m16 8h44v6h-44" fill="#edc999" />
          <path d="M0 104h48v-8h32v8h24v12h32v12H0" fill="#f6d7a1" />
          <path d="M28 110V48h8v62M8 48h20V38h8v10h24v8H36v8H20v-8H8" fill="#324f4a" />
        </>
      )}
      <path d="M0 120h240v8H0" fill="#263d3c" />
    </svg>
  );
}
