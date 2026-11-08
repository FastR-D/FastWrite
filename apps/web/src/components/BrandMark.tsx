import brandMarkUrl from "../assets/favicon.svg";

export function BrandMark() {
  return <img className="brand__mark" src={brandMarkUrl} width={28} height={28} alt="" aria-hidden="true" draggable={false} />;
}
