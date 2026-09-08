import { cookies } from 'next/headers';
import LookupForm from '@/components/number-lookup/LookupForm';
import { readGenesysAuthCookie } from '@/lib/genesys/auth-cookies.mjs';

export default async function NumberLookupPage() {
  const cookieStore = await cookies();
  const token = readGenesysAuthCookie(cookieStore, 'genesys_access_token');

  return (
    <div className="container mx-auto py-8">
      <LookupForm accessToken={token} />
    </div>
  );
}
