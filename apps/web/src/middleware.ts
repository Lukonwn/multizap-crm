import { NextResponse, type NextRequest } from 'next/server';

// A validação real da sessão é feita pela API; aqui apenas evitamos renderizar
// o painel para quem nem possui cookie de sessão.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || req.cookies.has('mz_session')) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api|healthz|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)$).*)'],
};
