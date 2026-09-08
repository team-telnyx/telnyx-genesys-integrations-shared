import { cookies } from 'next/headers';
import NlCampaignForm from '@/components/number-lookup-campaign/NlCampaignForm';
import { readGenesysAuthCookie } from '@/lib/genesys/auth-cookies.mjs';

export default async function NumberLookupCampaignPage() {
  const cookieStore = await cookies();
  const token = readGenesysAuthCookie(cookieStore, 'genesys_access_token');

  return (
    <div className="container mx-auto py-8">
      <NlCampaignForm accessToken={token} />
    </div>
  );
}
