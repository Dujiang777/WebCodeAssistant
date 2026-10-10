/** 35mm 片孔条。用真实元素，避开已被占用的伪元素槽。 */
export function FilmSprocket({
  variant = 'left',
}: {
  variant?: 'left' | 'right' | 'page' | 'rail';
}) {
  return <div className={`film-sprocket film-sprocket-${variant}`} aria-hidden="true" />;
}
