import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'member_screen.dart';
import 'team_api.dart';
import 'team_models.dart';

/// Owner screen: the team roster, billing summary and "add team member".
class TeamScreen extends StatefulWidget {
  const TeamScreen({super.key, required this.api});

  final TeamApi api;

  @override
  State<TeamScreen> createState() => _TeamScreenState();
}

class _TeamScreenState extends State<TeamScreen> {
  TeamList? _data;
  bool _loading = true;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await widget.api.list();
      if (mounted) setState(() => _data = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _add() async {
    final result = await showDialog<_NewMember>(context: context, builder: (_) => const _AddMemberDialog());
    if (result == null) return;
    try {
      final created = await widget.api.create(displayName: result.name, self: result.self, performsServices: result.performs);
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MemberScreen(api: widget.api, memberId: created.id)));
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    return Scaffold(
      appBar: AppBar(title: const Text('Team')),
      floatingActionButton: data != null && data.canEdit
          ? FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.person_add_alt_1), label: const Text('Add member'))
          : null,
      body: _loading && data == null
          ? const LoadingView(label: 'Loading your team…')
          : _error != null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : data == null
                  ? const EmptyView(title: 'No team yet')
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        children: [
                          _BillingCard(billing: data.billing),
                          const SizedBox(height: AppSpacing.lg),
                          if (data.members.isEmpty) const EmptyView(title: 'No team members yet', message: 'Add yourself or your staff.'),
                          for (final m in data.members)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: CircleAvatar(child: Text(m.displayName.characters.first.toUpperCase())),
                              title: Text(m.displayName),
                              subtitle: Text(_subtitle(m)),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () async {
                                await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MemberScreen(api: widget.api, memberId: m.id)));
                                await _load();
                              },
                            ),
                        ],
                      ),
                    ),
    );
  }

  static String _subtitle(TeamMember m) {
    final parts = <String>[
      if (m.isOwner) 'Owner',
      switch (m.account) {
        'LINKED' => 'Account active',
        'INVITED' => 'Invitation sent',
        'INVITE_EXPIRED' => 'Invitation expired',
        _ => 'No login yet',
      },
      if (!m.isActive) 'Inactive' else if (!m.performsServices) 'Does not perform services' else 'Billable',
    ];
    return parts.join(' · ');
  }
}

class _BillingCard extends StatelessWidget {
  const _BillingCard({required this.billing});

  final TeamBilling billing;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Billable staff: ${billing.billableStaff}', style: style.titleMedium),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Only active members who perform services are billed. An owner who works counts once. '
              '${billing.activeNonPerforming} active non-performing, ${billing.inactive} inactive.',
              style: style.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class _NewMember {
  const _NewMember(this.name, this.self, this.performs);
  final String name;
  final bool self;
  final bool performs;
}

class _AddMemberDialog extends StatefulWidget {
  const _AddMemberDialog();

  @override
  State<_AddMemberDialog> createState() => _AddMemberDialogState();
}

class _AddMemberDialogState extends State<_AddMemberDialog> {
  final _name = TextEditingController();
  bool _self = false;
  bool _performs = true;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add team member'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('I perform services myself'),
            subtitle: const Text('Adds you as one team member'),
            value: _self,
            onChanged: (v) => setState(() => _self = v),
          ),
          if (!_self)
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name (as customers see it)'), textCapitalization: TextCapitalization.words),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Performs services (billable)'),
            value: _performs,
            onChanged: (v) => setState(() => _performs = v),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: () {
            if (!_self && _name.text.trim().length < 2) return;
            Navigator.pop(context, _NewMember(_name.text.trim(), _self, _performs));
          },
          child: const Text('Add'),
        ),
      ],
    );
  }
}
