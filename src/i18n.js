// -----------------------------------------------------------------------------
// Every text shown to the user, in French and English. A text shown in the
// Configuration screen is a { en, fr } object; device and feature names follow
// the "Language of the names" option. No secret ever enters a text, nor a raw
// value typed by the user (an invalid address or fingerprint is only counted).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const t = (fr, en) => ({ fr, en });

const cut = (text) =>
  text.length > LIMITS.actionText ? `${text.slice(0, LIMITS.actionText - 1)}…` : text;

export const T = {
  // Configuration problems.
  noHost: t(
    'Indiquez l’adresse IP d’au moins un interphone 2N.',
    'Enter the IP address of at least one 2N intercom.',
  ),
  hostsInvalid: t(
    'Aucune adresse valable : indiquez des adresses IP séparées par des virgules (par ex. 192.168.1.50, 192.168.1.51:8443).',
    'No valid address: enter IP addresses separated by commas (e.g. 192.168.1.50, 192.168.1.51:8443).',
  ),
  tooManyHosts: t('8 interphones au plus.', '8 intercoms at most.'),
  credentialsMissing: t(
    'Indiquez l’utilisateur et le mot de passe du compte de l’API HTTP de l’interphone, ou choisissez « Aucune » authentification.',
    'Enter the user and password of the HTTP API account of the intercom, or choose "None" as authentication.',
  ),
  configUnreadable: (ms) =>
    t(
      `Configuration illisible depuis Gladys, nouvel essai dans ${Math.round(ms / 1000)} s.`,
      `Configuration unreadable from Gladys, trying again in ${Math.round(ms / 1000)} s.`,
    ),
  ignored: (count) =>
    t(`${count} adresse(s) ignorée(s) : invalide(s)`, `${count} address(es) ignored: invalid`),
  badFingerprints: (count) =>
    t(
      `${count} empreinte(s) ignorée(s) : 64 chiffres hexadécimaux attendus`,
      `${count} fingerprint(s) ignored: 64 hexadecimal digits expected`,
    ),
  dataUnreadable: t(
    '/data illisible : les certificats approuvés et les refus d’identifiants ne sont pas gardés.',
    '/data unreadable: trusted certificates and refused credentials are not kept.',
  ),

  // One line per intercom.
  starting: (host) => t(`${host} : connexion…`, `${host}: connecting…`),
  ok: (host, model, switches) =>
    t(
      `${host} : ${model}, ${switches} relais`,
      `${host}: ${model}, ${switches} switch${switches === 1 ? '' : 'es'}`,
    ),
  down: (host) => t(`${host} : injoignable`, `${host}: unreachable`),
  untrusted: (host, fp) =>
    t(
      `${host} : certificat pas encore approuvé, rien n’est envoyé. Empreinte vue : ${fp}. Comparez-la à celle que montre votre navigateur sur la page web de l’interphone, puis cliquez deux fois sur « Approuver les certificats » (ou collez-la dans le champ des empreintes)`,
      `${host}: certificate not trusted yet, nothing is sent. Fingerprint seen: ${fp}. Compare it with the one your browser shows on the web page of the intercom, then click "Trust the certificates" twice (or paste it into the fingerprints field)`,
    ),
  untrustedUnread: (host) =>
    t(
      `${host} : certificat pas encore approuvé, rien n’est envoyé (certificat non lu : interphone injoignable ?)`,
      `${host}: certificate not trusted yet, nothing is sent (certificate not read: intercom unreachable?)`,
    ),
  pin: (host, fp) =>
    t(
      `${host} : l’interphone présente un AUTRE certificat que celui approuvé ; rien n’est envoyé. Empreinte vue : ${fp ?? 'illisible'}. S’il a été remplacé volontairement, approuvez-le à nouveau (deux clics)`,
      `${host}: the intercom shows ANOTHER certificate than the trusted one; nothing is sent. Fingerprint seen: ${fp ?? 'unreadable'}. If it was replaced on purpose, trust it again (two clicks)`,
    ),
  refused: (host) =>
    t(
      `${host} : identifiants refusés, plus aucun essai ; corrigez-les ou cliquez sur « Tester la connexion »`,
      `${host}: credentials refused, no more tries; fix them or click "Test the connection"`,
    ),
  method: (host) =>
    t(
      `${host} : l’interphone n’accepte pas cette authentification ; choisissez celle de la page Services > API HTTP`,
      `${host}: the intercom does not accept this authentication; choose the one of its Services > HTTP API page`,
    ),
  disabled: (host) =>
    t(
      `${host} : service désactivé dans la page Services > API HTTP de l’interphone`,
      `${host}: service off in the Services > HTTP API page of the intercom`,
    ),
  answer: (host) =>
    t(
      `${host} : réponse inattendue (est-ce bien l’API HTTP d’un interphone 2N ?)`,
      `${host}: unexpected answer (is this the HTTP API of a 2N intercom?)`,
    ),
  epSwitches: t('relais', 'switches'),
  epInputs: t('entrées', 'inputs'),
  epCalls: t('appels', 'calls'),
  epEvents: t('événements', 'events'),
  notAllowed: (what) =>
    t(
      `lecture des ${what.fr} non autorisée pour ce compte (droits de l’API HTTP)`,
      `${what.en} not allowed for this account (HTTP API privileges)`,
    ),
  notRead: (what) => t(`lecture des ${what.fr} en échec`, `${what.en} not read`),
  openOff: t('ouverture désactivée', 'opening off'),
  lastCommand: (text) => t(`dernière ouverture : ${text.fr}`, `last opening: ${text.en}`),

  // Results of an opening (status and ack).
  confirmed: (n) => t(`relais ${n} activé, confirmé`, `switch ${n} activated, confirmed`),
  acceptedUnconfirmed: (n) =>
    t(
      `relais ${n} : accepté par l’interphone, activation pas encore relue`,
      `switch ${n}: accepted by the intercom, activation not read back yet`,
    ),
  sentUnconfirmed: (n) =>
    t(
      `relais ${n} : envoyée, sans réponse de l’interphone (peut-être activé)`,
      `switch ${n}: sent, no answer from the intercom (maybe activated)`,
    ),
  rejectedByDevice: (n) =>
    t(
      `relais ${n} : refusée par l’interphone (relais verrouillé ou désactivé ?)`,
      `switch ${n}: refused by the intercom (switch locked or disabled?)`,
    ),
  notSent: (n, reason) =>
    t(`relais ${n} : rien envoyé (${reason.fr})`, `switch ${n}: nothing sent (${reason.en})`),

  // Reasons a command is refused before anything leaves.
  openDisabled: t(
    'ouverture désactivée dans la configuration',
    'opening is off in the configuration',
  ),
  unknownDevice: t('interphone inconnu ou pas encore lu', 'unknown intercom, or not read yet'),
  notButton: t('cette fonctionnalité n’est pas une commande', 'this feature is not a command'),
  badValue: t('valeur inattendue', 'unexpected value'),
  credentialsRefused: t('identifiants refusés', 'credentials refused'),
  refusedReason: t('refus de l’interphone (401)', 'refused by the intercom (401)'),
  untrustedReason: t('certificat pas encore approuvé', 'certificate not trusted yet'),
  pinReason: t(
    'l’interphone présente un autre certificat',
    'the intercom shows another certificate',
  ),
  privilegeReason: t(
    'droit « contrôle des relais » absent du compte',
    'the account lacks the switch control privilege',
  ),
  disabledReason: t('service désactivé sur l’interphone', 'service off on the intercom'),
  methodReason: t('authentification non acceptée', 'authentication not accepted'),
  unexpectedReason: t('réponse inattendue', 'unexpected answer'),
  otherDevice: t(
    'un autre interphone répond à cette adresse',
    'another intercom answers at this address',
  ),
  unreachable: t('interphone injoignable', 'intercom unreachable'),
  unknownSwitch: t('relais absent de l’interphone', 'switch not on the intercom'),
  switchDisabled: t('relais désactivé sur l’interphone', 'switch disabled on the intercom'),
  bistable: t(
    'relais en mode bistable : non pris en charge (il resterait activé)',
    'switch in bistable mode: not supported (it would stay on)',
  ),
  modeUnknown: t(
    'mode ou durée du relais illisible (seul le mode monostable est activé)',
    'switch mode or duration unreadable (only the monostable mode is triggered)',
  ),
  tooLong: (duration, max) =>
    t(
      `relais activé ${duration} s sur l’interphone, plus de ${max} s : non pris en charge`,
      `switch on for ${duration} s on the intercom, more than ${max} s: not supported`,
    ),
  queueFull: t('trop de commandes en attente', 'too many commands waiting'),
  tooLate: t('délai dépassé avant l’envoi', 'deadline passed before sending'),
  stopped: t('intégration arrêtée ou reconfigurée', 'integration stopped or reconfigured'),
  configLoading: t('configuration pas encore lue', 'configuration not read yet'),

  // Test button.
  testNoHost: t('Aucune adresse à tester.', 'No address to test.'),
  testTooSoon: (host) =>
    t(`${host} : testé il y a moins de 5 s`, `${host}: tested less than 5 s ago`),
  testOk: (host, model, serial) =>
    t(
      `${host} : ${model} (n° ${serial}), connexion réussie`,
      `${host}: ${model} (serial ${serial}), connected`,
    ),

  // "Trust the certificates" button.
  trust: {
    none: t(
      'Aucun certificat à approuver : chaque adresse a déjà le sien.',
      'No certificate to trust: every address already has its own.',
    ),
    confirm: (list) => {
      const fr = list.map((x) => `${x.host} : ${x.fp ?? 'certificat non lu'}`).join(' · ');
      const en = list.map((x) => `${x.host}: ${x.fp ?? 'certificate not read'}`).join(' · ');
      return t(
        cut(
          `Empreintes vues (rien d’autre n’a été envoyé) : ${fr}. Vérifiez chacune dans votre navigateur (page web de l’interphone, cadenas, certificat, empreinte SHA-256), puis cliquez à nouveau dans les 2 minutes pour les approuver.`,
        ),
        cut(
          `Fingerprints seen (nothing else was sent): ${en}. Check each one in your browser (web page of the intercom, padlock, certificate, SHA-256 fingerprint), then click again within 2 minutes to trust them.`,
        ),
      );
    },
    done: (list) =>
      t(
        cut(`Certificat approuvé : ${list.map((x) => `${x.host} : ${x.fp}`).join(' · ')}.`),
        cut(`Certificate trusted: ${list.map((x) => `${x.host}: ${x.fp}`).join(' · ')}.`),
      ),
    notKept: t(
      'Certificat NON approuvé : /data n’a pas pu être écrit ; rien n’est envoyé à l’interphone.',
      'Certificate NOT trusted: /data could not be written; nothing is sent to the intercom.',
    ),
  },

  // Names (language of the names).
  ring: { fr: 'Sonnette', en: 'Doorbell' },
  switchState: { fr: (n) => `Relais ${n} (état)`, en: (n) => `Switch ${n} (state)` },
  switchOpen: { fr: (n) => `Activer le relais ${n}`, en: (n) => `Activate switch ${n}` },
  input: { fr: (p) => `Entrée ${p}`, en: (p) => `Input ${p}` },
};
