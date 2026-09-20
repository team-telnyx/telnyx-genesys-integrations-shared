import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import {
  buildGenesysReauthResponse,
  isInvalidGenesysTokenError,
  readGenesysAuthCookie,
} from '../../../../lib/genesys/auth-cookies.mjs';
import { assertGenesysApiUrl } from '../../../../lib/genesys/api-origin.mjs';

export async function POST(request) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { 
    contactListId, 
    campaignType, 
    contactListUri, 
    template, 
    contactListColumns 
  } = await request.json();

  if (!contactListId || !campaignType || !contactListUri) {
    return NextResponse.json({ 
      error: 'contactListId, campaignType, and contactListUri are required' 
    }, { status: 400 });
  }

  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  // Same reason as the contact-list export route: this URI arrives in the
  // request body and is fetched with the caller's Genesys token attached.
  let contactListUrl;
  try {
    contactListUrl = assertGenesysApiUrl(contactListUri);
  } catch (error) {
    return NextResponse.json({ error: `contactListUri rejected: ${error.message}` }, { status: 400 });
  }
  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const messageDeploymentId = process.env.GC_MESSAGE_DEPLOYMENT_ID;

  try {
    // Fetch the contact list CSV file
    console.log(`Starting ${campaignType} campaign for contact list ID: ${contactListId}`);
    
    const csvResponse = await fetch(contactListUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!csvResponse.ok) {
      const error = await csvResponse.text();
      if (csvResponse.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, csvResponse.status);
      }
      throw new Error('Failed to fetch contact list export file');
    }

    const csvText = await csvResponse.text();
    const contacts = parseCSV(csvText);
    
    console.log(`Fetched ${contacts.length} contacts`);

    let processedCount = 0;
    let errorCount = 0;
    const errors = [];

    if (campaignType === 'SMS') {
      // SMS Campaign - Send agentless messages via Genesys
      if (!template) {
        return NextResponse.json({ error: 'Template is required for SMS campaign' }, { status: 400 });
      }

      for (const contact of contacts) {
        try {
          // Replace template placeholders with contact data
          let message = template;
          if (contactListColumns) {
            for (const column of contactListColumns) {
              message = message.replace(
                new RegExp(`\\{\\{${column}\\}\\}`, 'g'),
                contact[column] || ''
              );
            }
          }

          const toAddress = `${contact.Number}|${contactListId}|${contact['inin-outbound-id']}`;
          
          const agentlessData = {
            fromAddress: messageDeploymentId,
            toAddress: toAddress,
            toAddressMessengerType: 'open',
            textBody: message,
            useExistingActiveConversation: false
          };

          const msgResponse = await fetch(
            `https://api.${environment}/api/v2/conversations/messages/agentless`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(agentlessData)
            }
          );

          if (msgResponse.ok) {
            processedCount++;
            console.log(`Sent message ${processedCount} to ${contact.Number}`);
          } else {
            const errText = await msgResponse.text();
            if (msgResponse.status === 401 && isInvalidGenesysTokenError(errText)) {
              return buildGenesysReauthResponse(NextResponse, errText, msgResponse.status);
            }
            errorCount++;
            errors.push({ contact: contact.Number, error: errText });
          }
        } catch (err) {
          errorCount++;
          errors.push({ contact: contact.Number, error: err.message });
        }
      }
    } else if (campaignType === 'NL') {
      // Number Lookup Campaign - Lookup numbers and update contacts in Genesys
      if (!telnyxApiKey) {
        return NextResponse.json({ error: 'Telnyx API key not configured' }, { status: 500 });
      }

      for (const contact of contacts) {
        try {
          // Perform Telnyx number lookup
          const lookupResponse = await fetch(
            `https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(contact.Number)}?type=carrier&type=caller-name`,
            {
              headers: {
                'Authorization': `Bearer ${telnyxApiKey}`,
                'Content-Type': 'application/json'
              }
            }
          );

          if (!lookupResponse.ok) {
            throw new Error('Number lookup failed');
          }

          const lookupResult = await lookupResponse.json();
          const lookupData = lookupResult.data;

          // Update contact in Genesys with lookup results
          const contactUpdate = {
            data: {
              Number: contact.Number,
              NationalFormat: lookupData.national_format || '',
              CountryCode: lookupData.country_code || '',
              MobileCountryCode: lookupData.carrier?.mobile_country_code || '',
              MobileNetworkCode: lookupData.carrier?.mobile_network_code || '',
              CarrierName: lookupData.carrier?.name || '',
              Type: lookupData.carrier?.type || '',
              ValidNumber: lookupData.valid_number ? 'true' : 'false',
              CallerName: lookupData.caller_name?.caller_name || ''
            }
          };

          const updateResponse = await fetch(
            `https://api.${environment}/api/v2/outbound/contactlists/${contactListId}/contacts/${contact['inin-outbound-id']}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(contactUpdate)
            }
          );

          if (updateResponse.ok) {
            processedCount++;
            console.log(`Updated contact ${processedCount}: ${contact.Number}`);
          } else {
            const errText = await updateResponse.text();
            if (updateResponse.status === 401 && isInvalidGenesysTokenError(errText)) {
              return buildGenesysReauthResponse(NextResponse, errText, updateResponse.status);
            }
            errorCount++;
            errors.push({ contact: contact.Number, error: errText });
          }
        } catch (err) {
          errorCount++;
          errors.push({ contact: contact.Number, error: err.message });
        }
      }
    } else {
      return NextResponse.json({ error: 'Invalid campaign type' }, { status: 400 });
    }

    return NextResponse.json({
      message: `Campaign completed. Processed: ${processedCount}, Errors: ${errorCount}`,
      processed: processedCount,
      errors: errorCount,
      errorDetails: errors.slice(0, 10) // Return first 10 errors
    });
  } catch (error) {
    console.error(`Error processing ${campaignType} campaign:`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Helper function to parse CSV
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]);
  const contacts = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const contact = {};
    headers.forEach((header, idx) => {
      contact[header] = values[idx] || '';
    });
    contacts.push(contact);
  }

  return contacts;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}
