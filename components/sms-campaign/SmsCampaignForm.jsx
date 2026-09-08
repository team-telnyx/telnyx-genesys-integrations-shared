"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { MessagesSquare, Users, RefreshCw, Play, AlertTriangle, Phone, User, FileText, Calendar, Link as LinkIcon, Hash, Home } from "lucide-react";
import Link from "next/link";
import { genesysAuthenticatedFetch } from "@/lib/genesys/admin-client-auth";

const getColumnIcon = (colName) => {
  const name = colName.toLowerCase();
  if (name.includes('number') || name.includes('phone') || name.includes('tel')) return Phone;
  if (name.includes('name') || name.includes('user')) return User;
  if (name.includes('date') || name.includes('time')) return Calendar;
  if (name.includes('link') || name.includes('url')) return LinkIcon;
  if (name.includes('title') || name.includes('message') || name.includes('text')) return FileText;
  return Hash;
};

const redirectToGenesysLogin = () => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
};

const handleGenesysReauthRequired = (data) => {
  if (!data?.reauthRequired) {
    return false;
  }

  toast.error("Genesys session expired. Redirecting to login...");
  redirectToGenesysLogin();
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseApiResponse = async (response) => {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};

const isPendingExportUriError = (data) => {
  const text = typeof data === "string" ? data : JSON.stringify(data || {});
  return text.includes("no.available.list.export.uri");
};

export default function SmsCampaignForm({ accessToken }) {
  // Contact Lists state
  const [contactLists, setContactLists] = useState([]);
  const [selectedContactList, setSelectedContactList] = useState(null);
  const [contactListColumns, setContactListColumns] = useState([]);
  const [contactListUri, setContactListUri] = useState("");
  const exportRequestRef = useRef(0);
  const [isLoadingLists, setIsLoadingLists] = useState(false);

  // Template state
  const [templateLibraries, setTemplateLibraries] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [templateSubstitutions, setTemplateSubstitutions] = useState([]);
  const [substitutionsValid, setSubstitutionsValid] = useState(false);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);

  // Contacts preview state
  const [contacts, setContacts] = useState([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [showContactsModal, setShowContactsModal] = useState(false);

  // Campaign state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isCampaignRunning, setIsCampaignRunning] = useState(false);

  const contactListPrefix = process.env.NEXT_PUBLIC_SMS_CONTACT_LISTS_PREFIX || "";
  const templatePrefix = process.env.NEXT_PUBLIC_SMS_TEMPLATES_PREFIX || "";

  // Load template libraries on mount
  useEffect(() => {
    if (accessToken) {
      fetchTemplateLibraries();
    }
  }, [accessToken]);

  // Load templates when library is selected
  useEffect(() => {
    if (selectedLibraryId) {
      fetchTemplates(selectedLibraryId);
    }
  }, [selectedLibraryId]);

  // Update template content when template is selected
  useEffect(() => {
    if (selectedTemplateId && templates.length > 0) {
      const selected = templates.find((t) => t.id === selectedTemplateId);
      if (selected) {
        const content = selected.texts?.[0]?.content || "";
        setTemplateContent(content);
        const subs = selected.substitutions?.map((s) => s.id) || [];
        setTemplateSubstitutions(subs);
      }
    }
  }, [selectedTemplateId, templates]);

  // Check substitutions validity
  useEffect(() => {
    if (templateSubstitutions.length === 0 && selectedTemplateId) {
      setSubstitutionsValid(true);
    } else if (contactListColumns.length > 0 && templateSubstitutions.length > 0) {
      const valid = templateSubstitutions.every((sub) => contactListColumns.includes(sub));
      setSubstitutionsValid(valid);
    } else {
      setSubstitutionsValid(false);
    }
  }, [templateSubstitutions, contactListColumns, selectedTemplateId]);

  const fetchContactLists = async () => {
    setIsLoadingLists(true);
    try {
      const params = new URLSearchParams();
      if (contactListPrefix) {
        params.append("name", contactListPrefix);
      }
      const response = await genesysAuthenticatedFetch(`/api/genesys/contactlists?${params}`);
      const data = await response.json();
      if (response.ok) {
        setContactLists(data.entities || []);
        setSelectedContactList(null);
        setContactListColumns([]);
        setContactListUri("");
        toast.success("Contact lists retrieved successfully");
      } else {
        if (handleGenesysReauthRequired(data)) {
          return;
        }
        throw new Error(data.error || "Failed to fetch contact lists");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsLoadingLists(false);
    }
  };

  const fetchTemplateLibraries = async () => {
    try {
      const response = await genesysAuthenticatedFetch("/api/genesys/response-libraries");
      const data = await response.json();
      if (response.ok) {
        let libs = data.entities || [];
        if (templatePrefix) {
          libs = libs.filter((lib) => lib.name.startsWith(templatePrefix));
        }
        setTemplateLibraries(libs);
      } else if (handleGenesysReauthRequired(data)) {
        return;
      }
    } catch (error) {
      console.error("Error fetching template libraries:", error);
    }
  };

  const fetchTemplates = async (libraryId) => {
    setIsLoadingTemplates(true);
    try {
      const response = await genesysAuthenticatedFetch(`/api/genesys/responses?libraryId=${libraryId}`);
      const data = await response.json();
      if (response.ok) {
        setTemplates(data.entities || []);
        toast.success("Templates retrieved successfully");
      } else {
        if (handleGenesysReauthRequired(data)) {
          return;
        }
        throw new Error(data.error || "Failed to fetch templates");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  const applySelectedContactList = (list) => {
    setSelectedContactList(list);
    const cols = (list.columnNames || []).filter((col) => !col.startsWith("TELNYX_"));
    setContactListColumns(cols);
    return cols;
  };

  const waitForContactListExportUri = async (listId) => {
    const createResponse = await genesysAuthenticatedFetch(`/api/genesys/contactlists/${listId}/export`, { method: "POST" });
    const createData = await parseApiResponse(createResponse);

    if (!createResponse.ok) {
      if (handleGenesysReauthRequired(createData)) {
        return "";
      }
      throw new Error(createData.error || "Failed to start contact list export");
    }

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await sleep(attempt === 1 ? 300 : 700);

      const exportRes = await genesysAuthenticatedFetch(`/api/genesys/contactlists/${listId}/export`);
      const exportData = await parseApiResponse(exportRes);

      if (exportRes.ok && exportData.uri) {
        return exportData.uri;
      }

      if (exportRes.status === 404 && isPendingExportUriError(exportData)) {
        continue;
      }

      if (!exportRes.ok) {
        if (handleGenesysReauthRequired(exportData)) {
          return "";
        }
        throw new Error(exportData.error || "Failed to fetch contact list export URI");
      }
    }

    throw new Error("Contact list export is still being prepared. Please try again in a moment.");
  };

  const handleRowClick = async (list) => {
    const requestId = ++exportRequestRef.current;
    setContactListUri("");
    applySelectedContactList(list);

    try {
      const uri = await waitForContactListExportUri(list.id);
      if (requestId !== exportRequestRef.current) return "";
      setContactListUri(uri);
      return uri;
    } catch (error) {
      if (requestId !== exportRequestRef.current) return "";
      setContactListUri("");
      console.error("Error creating export:", error);
      toast.error(error.message);
      return "";
    }
  };

  const handlePreviewContacts = async (list = selectedContactList) => {
    if (!list) {
      toast.error("Please select a contact list first");
      return;
    }

    const requestId = ++exportRequestRef.current;
    const reusableUri = selectedContactList?.id === list.id ? contactListUri : "";
    if (!reusableUri) setContactListUri("");
    applySelectedContactList(list);
    setContacts([]);
    setIsLoadingContacts(true);
    setShowContactsModal(true);

    try {
      const uri = reusableUri
        ? reusableUri
        : await waitForContactListExportUri(list.id);

      if (requestId !== exportRequestRef.current) return;

      if (!uri) {
        setShowContactsModal(false);
        return;
      }

      setContactListUri(uri);

      const response = await genesysAuthenticatedFetch(
        `/api/genesys/contactlists/${list.id}/contacts?url=${encodeURIComponent(uri)}`
      );
      const data = await response.json();
      if (requestId !== exportRequestRef.current) return;
      if (response.ok) {
        setContacts(data.contacts || []);
      } else {
        if (handleGenesysReauthRequired(data)) {
          setShowContactsModal(false);
          return;
        }
        throw new Error(data.error || "Failed to fetch contacts");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      if (requestId === exportRequestRef.current) setIsLoadingContacts(false);
    }
  };

  const handleStartCampaign = async () => {
    setShowConfirmModal(false);
    setIsCampaignRunning(true);

    try {
      const response = await genesysAuthenticatedFetch("/api/campaign/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactListId: selectedContactList.id,
          campaignType: "SMS",
          contactListUri: contactListUri,
          template: templateContent,
          contactListColumns: contactListColumns,
        }),
      });

      const data = await response.json();
      if (handleGenesysReauthRequired(data)) return;
      if (response.ok) {
        toast.success(data.message);
      } else {
        throw new Error(data.error || "Campaign failed");
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsCampaignRunning(false);
    }
  };

  // Highlight substitutions in template content
  const highlightTemplate = (content) => {
    if (!content) return null;
    const parts = content.split(/(\{\{[^}]+\}\})/g);
    return parts.map((part, idx) => {
      if (part.match(/^\{\{[^}]+\}\}$/)) {
        const varName = part.slice(2, -2);
        const isValid = contactListColumns.includes(varName);
        return (
          <span
            key={idx}
            className={`font-semibold ${
              isValid ? "text-telnyx-green bg-telnyx-green/20" : "text-red-500 bg-red-100"
            } px-1 rounded`}
          >
            {part}
          </span>
        );
      }
      return <span key={idx}>{part}</span>;
    });
  };

  const canStartCampaign =
    selectedContactList && selectedTemplateId && substitutionsValid && contactListUri;

  return (
    <div className="px-4 lg:px-6 space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MessagesSquare className="size-6 text-telnyx-green" /> SMS Campaign
          </CardTitle>
          <Link href="/">
            <Button variant="outline" size="sm">
              <Home className="h-4 w-4 mr-2" />
              Home
            </Button>
          </Link>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={fetchContactLists}
              disabled={isLoadingLists}
              className="bg-telnyx-green hover:bg-telnyx-green/90"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingLists ? "animate-spin" : ""}`} />
              Get Contact Lists
            </Button>
            <Button
              onClick={() => setShowConfirmModal(true)}
              disabled={!canStartCampaign || isCampaignRunning}
              variant="destructive"
            >
              <Play className="mr-2 h-4 w-4" />
              {isCampaignRunning ? "Running..." : "Start Campaign"}
            </Button>
          </div>

          {/* Contact Lists Table */}
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact List ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Columns</TableHead>
                  <TableHead className="w-20">Size</TableHead>
                  <TableHead className="w-24">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactLists.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      {isLoadingLists ? "Loading..." : "No contact lists. Click 'Get Contact Lists' to fetch."}
                    </TableCell>
                  </TableRow>
                ) : (
                  contactLists.map((list) => (
                    <TableRow
                      key={list.id}
                      className={`cursor-pointer ${
                        selectedContactList?.id === list.id ? "bg-muted" : ""
                      }`}
                      onClick={() => handleRowClick(list)}
                    >
                      <TableCell className="font-mono text-xs">{list.id}</TableCell>
                      <TableCell>{list.name}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(list.columnNames || [])
                            .filter((col) => !col.startsWith("TELNYX_"))
                            .slice(0, 5)
                            .map((col) => (
                              <Badge key={col} variant="secondary" className="text-xs">
                                {col}
                              </Badge>
                            ))}
                          {(list.columnNames || []).filter((col) => !col.startsWith("TELNYX_"))
                            .length > 5 && (
                            <Badge variant="outline" className="text-xs">
                              +
                              {(list.columnNames || []).filter((col) => !col.startsWith("TELNYX_"))
                                .length - 5}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{list.size}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePreviewContacts(list);
                          }}
                        >
                          <Users className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Template Selection */}
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Template Library</label>
                <Select value={selectedLibraryId} onValueChange={setSelectedLibraryId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select response library" />
                  </SelectTrigger>
                  <SelectContent>
                    {templateLibraries.map((lib) => (
                      <SelectItem key={lib.id} value={lib.id}>
                        {lib.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Template</label>
                <Select
                  value={selectedTemplateId}
                  onValueChange={setSelectedTemplateId}
                  disabled={!selectedLibraryId || isLoadingTemplates}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={isLoadingTemplates ? "Loading..." : "Select template"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Template Preview */}
            {selectedTemplateId && templateContent && (
              <div
                className={`p-4 rounded-lg border-2 ${
                  substitutionsValid ? "border-telnyx-green/50 bg-telnyx-green/5" : "border-red-300 bg-red-50 dark:bg-red-900/20"
                }`}
              >
                <div className="text-sm font-medium mb-2">Template Preview</div>
                <div className="whitespace-pre-wrap text-sm">{highlightTemplate(templateContent)}</div>
                {!substitutionsValid && templateSubstitutions.length > 0 && (
                  <div className="mt-3 text-xs text-red-500 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Some variables don&apos;t match contact list columns
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Contacts Preview Modal */}
      <Dialog open={showContactsModal} onOpenChange={setShowContactsModal}>
        <DialogContent className="max-w-[90vw] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-telnyx-green" />
              Contacts Preview
            </DialogTitle>
            <DialogDescription>
              {selectedContactList?.name} - {contacts.length} contacts
            </DialogDescription>
          </DialogHeader>
          <div className="border rounded-lg overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {contactListColumns.map((col) => (
                    <TableHead key={col}>{col}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingContacts ? (
                  <TableRow>
                    <TableCell colSpan={contactListColumns.length} className="text-center">
                      Loading contacts...
                    </TableCell>
                  </TableRow>
                ) : contacts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={contactListColumns.length} className="text-center">
                      No contacts found
                    </TableCell>
                  </TableRow>
                ) : (
                  contacts
                    .filter((contact) => contactListColumns.some((col) => contact[col] && String(contact[col]).trim()))
                    .slice(0, 100)
                    .map((contact, idx) => (
                      <TableRow key={`contact-${idx}`}>
                        {contactListColumns.map((col) => (
                          <TableCell key={col}>{contact[col]}</TableCell>
                        ))}
                      </TableRow>
                    ))
                )}
              </TableBody>
            </Table>
          </div>
          {contacts.length > 100 && (
            <p className="text-sm text-muted-foreground text-center">
              Showing first 100 of {contacts.length} contacts
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmation Modal */}
      <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Start SMS Campaign
            </DialogTitle>
            <DialogDescription>
              Please confirm starting the <strong>{selectedContactList?.name}</strong> campaign. This
              will send messages to all {selectedContactList?.size} contacts and may incur significant
              charges.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleStartCampaign}>
              Yes, Start Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
