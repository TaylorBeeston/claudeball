/** Is this a phone-class device? The audio layer then does less: fewer crowd voices and incidental sounds, a slower tick. `?lowpower=1|0` forces it. */
export function isLowPower(): boolean {
  try {
    const f = new URLSearchParams(location.search).get('lowpower');
    if (f === '1') return true;
    if (f === '0') return false;
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const mobileUa = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent ?? '');
    return coarse || mobileUa;
  } catch {
    return false;
  }
}
