import { cookies } from 'next/headers';
import SmsCampaignForm from '@/components/sms-campaign/SmsCampaignForm';
import { readGenesysAuthCookie } from '@/lib/genesys/auth-cookies.mjs';

export default async function SmsCampaignPage() {
  const cookieStore = await cookies();
  const token = readGenesysAuthCookie(cookieStore, 'genesys_access_token');

  return (
    <div className="container mx-auto py-8">
      <SmsCampaignForm accessToken={token} />
    </div>
  );
}
