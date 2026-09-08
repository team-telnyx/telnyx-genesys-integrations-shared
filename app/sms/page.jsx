import { cookies } from 'next/headers';
import SmsForm from '@/components/sms/SmsForm';
import { readGenesysAuthCookie } from '@/lib/genesys/auth-cookies.mjs';

export default async function SMSPage() {
  const cookieStore = await cookies();
  const token = readGenesysAuthCookie(cookieStore, 'genesys_access_token');

  return (
    <div className="container mx-auto py-8">
      <SmsForm accessToken={token} />
    </div>
  );
}
