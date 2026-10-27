import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The PEM certificates in a text; throws if there is none or one does not parse. */
export const parseCertificates = (pem: string): string[] => {
    const certificates = pem.match(PEM_CERTIFICATE) ?? [];
    if (certificates.length === 0) throw new Error('expected PEM certificates (-----BEGIN CERTIFICATE-----)');
    for (const certificate of certificates) new X509Certificate(certificate);
    return certificates;
};

/**
 * Trusts additional CA certificates for every TLS connection of the process, next to Node's bundled ones: sources
 * behind an internal CA (an on-premises API, a database with TLS) are reached without disabling verification.
 */
export const trustCertificates = (certificates: string[]): void => {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...certificates]);
};
