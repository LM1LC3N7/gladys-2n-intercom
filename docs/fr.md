# Interphones 2N IP pour Gladys

Intégration externe de Gladys Assistant (5.1.0 ou plus récent) pour les interphones et unités d'accès
2N IP (Verso, Force, Safety, Solo, Style, Base, Access Unit…) de votre réseau local, par leur API HTTP
officielle en HTTPS, sans aucun cloud. **Non officielle, sans lien avec 2N. Jamais testé avec un vrai appareil** : elle est écrite d'après le manuel « 2N IP HTTP API » (version 3.3, firmware 2.50) et testée
sur un interphone simulé. Vos retours sont bienvenus.

## Ce que vous obtenez

Pour chaque interphone :

- **Sonnette** (lecture seule) : 1 tant qu'un visiteur sonne (l'interphone lance un appel sortant), 0
  sinon ;
- **Relais n (état)** (lecture seule), pour chaque relais (« switch » 1 à 4) activé dans l'interphone :
  0 activé (gâche ouverte), 1 au repos ;
- **Activer le relais n** : un bouton, **désactivé par défaut** (voir plus bas) ;
- **Entrée …** (lecture seule) : l'état de chaque entrée numérique (contact de porte, bouton de sortie…) ;
- des **déclencheurs de scène** : « Sonnette 2N » (une fois par appel), « Relais 2N activé » (avec le
  numéro et l'origine dite par l'interphone : `auth`, `ap`, `dtmf`, `automation`…), « Accès 2N accordé »
  et « Accès 2N refusé » (avec le nom de l'utilisateur de l'annuaire, le sens `entry` ou `exit`, et le
  motif du refus).

Les codes saisis, les numéros de badge et les identifiants d'utilisateur ne sont jamais publiés ni gardés.

## Préparer l'interphone

1. Dans la page web de l'interphone, **Services > API HTTP** : activez les services **Système**,
   **Commutateur** (Switch), **E/S** (I/O), **Téléphone/Appel** et **Journal** (Logging), chacun en
   **HTTPS** avec l'authentification **Digest** (le réglage conseillé par 2N).
2. Sur le même onglet, créez un **compte** (5 au plus) pour Gladys, avec les droits : surveillance et
   contrôle des commutateurs, surveillance des E/S, surveillance des appels, et, pour les accès, la
   surveillance des badges/UID. Un droit absent n'est pas une erreur : la partie correspondante est
   simplement « non autorisée » dans le statut, le reste fonctionne.
3. Donnez à l'interphone une adresse IP fixe dans votre box.

## Configurer l'intégration

- **Adresses des interphones** : leurs adresses IP séparées par des virgules (8 au plus), avec `:port`
  si le port HTTPS n'est pas 443.
- **Authentification**, **utilisateur**, **mot de passe** : ceux du compte créé ci-dessus (le même sur
  tous les interphones). Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
  seulement aux interphones listés, une fois leur certificat approuvé ; avec Digest, seule une preuve en
  circule.
- **Intervalle de lecture** (5 à 300 s, 10 par défaut) : la relecture des relais, des entrées et des
  appels. Les événements arrivent, eux, tout de suite (canal d'événements de l'interphone).

### Approuver le certificat (obligatoire)

L'interphone présente un certificat à lui, qu'aucune autorité ne garantit. **Rien n'est envoyé à un
interphone tant que son certificat n'est pas approuvé** : le statut montre alors l'empreinte SHA-256
vue. Pour l'approuver :

- cliquez sur **Approuver les certificats** : l'intégration lit le certificat de chaque interphone non
  encore approuvé et affiche son empreinte (rien d'autre n'est envoyé) ; comparez-la à celle que montre
  votre navigateur sur la page web de l'interphone (cadenas, certificat, empreinte SHA-256) ; puis
  **cliquez à nouveau dans les 2 minutes** : chaque interphone qui présente encore la même empreinte est
  approuvé, et l'approbation est gardée dans `/data` (si `/data` ne peut pas être écrit, rien n'est
  approuvé) ;
- ou collez les empreintes dans le champ **Empreintes des certificats**, séparées par des virgules.

Si un interphone présente plus tard **un autre certificat**, rien ne lui est envoyé (ni mot de passe, ni
commande), le statut affiche l'empreinte vue, et l'intégration ne l'apprend jamais d'elle-même :
approuvez-le à nouveau (deux clics) s'il a été remplacé volontairement (nouveau certificat, remise à
zéro).

## Activer un relais (ouvrir une porte)

Toute personne pouvant piloter les appareils dans Gladys (tableau de bord, scènes, application) peut
ouvrir les portes une fois l'option **Autoriser l'activation des relais depuis Gladys** cochée :
ne la cochez que si votre Gladys est bien protégé.

- L'activation est un **bouton**, jamais un interrupteur : un « tout éteindre » n'ouvre jamais une
  porte.
- Juste avant chaque activation, l'intégration relit l'identité de l'interphone (son numéro de série
  doit être celui de l'appareil du bouton) et les réglages du relais, puis vérifie l'option une
  dernière fois avant d'envoyer.
- Seuls les relais **monostables** sont activés, et seulement si leur durée d'activation (réglée dans
  l'interphone) est de **60 s au plus** : le relais se coupe de lui-même après cette durée, quoi qu'il
  arrive à Gladys. Il n'y a donc pas de commande « fermer ».
- Une activation n'est **jamais renvoyée** par l'intégration, ni après un redémarrage.
- La réponse indique : « confirmé » (le relais est relu activé, ou l'interphone signale l'activation
  par l'API), « accepté, pas encore relu », « envoyée, sans réponse (peut-être activé) », « refusée par
  l'interphone » (relais verrouillé ou désactivé), ou « rien envoyé » avec la raison.

Une activation est refusée, **sans rien envoyer**, quand : l'option est décochée ; le certificat n'est
pas approuvé ou a changé ; les identifiants ont été refusés ; l'interphone n'a pas encore été lu, est
injoignable ou ne répond pas à temps ; un autre interphone répond à l'adresse ; le relais est absent,
désactivé, bistable, de mode ou de durée illisible, ou activé plus de 60 s ; le compte n'a pas le droit
de contrôle des relais ; plus de 4 commandes attendent déjà ; l'intégration s'arrête ou est
reconfigurée ; le délai de 3,3 s est dépassé avant l'envoi.

Le déclencheur « Relais 2N activé » ignore l'activation faite par Gladys elle-même (une scène qui
ouvrirait la porte sur ce déclencheur ne boucle pas).

## Bon à savoir

- **Identifiants refusés** (401 sur la lecture de l'identité) : l'interphone n'est plus sollicité,
  même après un redémarrage, tant que vous ne changez pas les identifiants, n'enregistrez pas la
  configuration ou ne cliquez pas sur **Tester la connexion**. Un refus sur une autre fonction (droit
  absent) n'est pas un refus d'identifiants : cette fonction est redemandée après 1 min, puis en
  doublant jusqu'à 1 h.
- Le canal d'événements est réouvert après une coupure ; les événements survenus pendant la coupure
  sont perdus, et une lecture du canal arrivée après un long silence (plus de 90 s) est ignorée pour ne
  pas publier d'anciens événements. Les états sont corrigés par la lecture suivante.
- `/data` ne garde que les certificats approuvés (leur empreinte, une valeur publique) et une marque
  de 8 bits des identifiants refusés, jamais un mot de passe.

## Pour aller plus loin

Code et suivi : <https://github.com/LM1LC3N7/gladys-2n-intercom>. Manuel de l'API :
<https://wiki.2n.com/hip/hapi/latest/en>.
