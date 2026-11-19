import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'local_store.dart';
import 'offline_models.dart';
import 'sync_engine.dart';

/// "Needs attention": changes the server refused (for a rule: the customer cancelled online, the grace period was not over...) or that
/// kept failing. The server's answer is final; the person reads it and dismisses it. Nothing here is hidden or retried silently.
class AttentionScreen extends StatefulWidget {
  const AttentionScreen({super.key, required this.engine, required this.store});
  final SyncEngine engine;
  final LocalStore store;

  @override
  State<AttentionScreen> createState() => _AttentionScreenState();
}

class _AttentionScreenState extends State<AttentionScreen> {
  List<PendingOp> _ops = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.engine.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    widget.engine.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final all = await widget.store.ops();
    if (!mounted) return;
    setState(() {
      _ops = all.where((o) => o.state == OpState.rejected || o.state == OpState.failed).toList();
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Needs attention')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _ops.isEmpty
              ? const Center(child: Padding(padding: EdgeInsets.all(AppSpacing.xl), child: Text('Nothing needs your attention. Every change was accepted.', textAlign: TextAlign.center)))
              : ListView.separated(
                  padding: const EdgeInsets.all(AppSpacing.lg),
                  itemCount: _ops.length,
                  separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                  itemBuilder: (_, i) {
                    final o = _ops[i];
                    final failed = o.state == OpState.failed;
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('${o.title}${o.subject.isEmpty ? '' : ' · ${o.subject}'}', style: style.titleMedium),
                          const SizedBox(height: AppSpacing.xs),
                          Text('Done on this phone at ${_clock(o.createdAt.toLocal())}', style: style.bodySmall),
                          const SizedBox(height: AppSpacing.sm),
                          Text(
                            failed
                                ? 'It could not be sent after several tries. ${o.message ?? ''}'
                                : 'The server did not accept it: ${o.message ?? 'a rule of the salon applies.'}',
                            style: const TextStyle(color: AppColors.danger),
                          ),
                          const SizedBox(height: AppSpacing.md),
                          Wrap(spacing: AppSpacing.sm, children: [
                            if (failed) FilledButton.tonal(onPressed: () => widget.engine.retryOp(o.id), child: const Text('Try again')),
                            OutlinedButton(onPressed: () => widget.engine.discardOp(o.id), child: Text(failed ? 'Discard' : 'Dismiss')),
                          ]),
                        ]),
                      ),
                    );
                  },
                ),
    );
  }
}

String _clock(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
